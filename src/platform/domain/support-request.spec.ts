import {
  ConflictError,
  DomainValidationError,
} from '../../shared/domain/errors.js';
import {
  REQUESTER_LOST_PERMISSION,
  SUPPORT_REQUEST_TEXT_MAX,
  SUPPORT_REQUEST_TTL_DAYS,
  SupportRequest,
} from './support-request.js';

const NOW = new Date('2026-11-07T12:00:00Z');
const SUPPORT = '019a1b2c-0000-7000-8000-0000000000b1';
const ADMIN = '019a1b2c-0000-7000-8000-0000000000a1';
const HUB = '019a1b2c-0000-7000-8000-0000000000d1';
const ORG = '019a1b2c-0000-7000-8000-0000000000e1';
const USER = '019a1b2c-0000-7000-8000-0000000000c1';
const later = (ms: number) => new Date(NOW.getTime() + ms);
const DAY = 86_400_000;

const deregister = (
  over: Partial<Parameters<typeof SupportRequest.create>[0]> = {},
) =>
  SupportRequest.create({
    type: 'hub_force_deregister',
    target: { hubId: HUB },
    reason: 'Owner lost the account',
    evidence: 'Invoice 4567, ID checked',
    requestedBy: SUPPORT,
    now: NOW,
    ...over,
  });

const expectCode = (fn: () => unknown, cls: Function, code: string) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(cls);
    expect((err as DomainValidationError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
};

describe('SupportRequest', () => {
  it('creates a pending request that expires in 7 days', () => {
    const r = deregister();
    expect(SUPPORT_REQUEST_TTL_DAYS).toBe(7);
    expect(r.status).toBe('pending');
    expect(r.targetHubId).toBe(HUB);
    expect(r.targetOrganizationId).toBeNull();
    expect(r.targetUserId).toBeNull();
    expect(r.requestedBy).toBe(SUPPORT);
    expect(r.decidedBy).toBeNull();
    expect(r.expiresAt).toEqual(later(7 * DAY));
  });

  it('accepts an appointment with organization and user', () => {
    const r = SupportRequest.create({
      type: 'org_appoint_admin',
      target: { organizationId: ORG, userId: USER },
      reason: 'r',
      evidence: 'e',
      requestedBy: SUPPORT,
      now: NOW,
    });
    expect(r.targetOrganizationId).toBe(ORG);
    expect(r.targetUserId).toBe(USER);
    expect(r.targetHubId).toBeNull();
  });

  it.each([
    ['hub_force_deregister', {}],
    ['hub_force_deregister', { hubId: HUB, organizationId: ORG }],
    ['hub_force_deregister', { hubId: HUB, userId: USER }],
    ['org_appoint_admin', { organizationId: ORG }],
    ['org_appoint_admin', { userId: USER }],
    ['org_appoint_admin', { organizationId: ORG, userId: USER, hubId: HUB }],
    ['something_else', { hubId: HUB }],
  ] as const)('rejects type %s with target %j', (type, target) => {
    expectCode(
      () =>
        SupportRequest.create({
          type: type as 'hub_force_deregister',
          target,
          reason: 'r',
          evidence: 'e',
          requestedBy: SUPPORT,
          now: NOW,
        }),
      DomainValidationError,
      'support-request-target-invalid',
    );
  });

  it.each(['', '   ', 'x'.repeat(SUPPORT_REQUEST_TEXT_MAX + 1)])(
    'rejects reason %j (empty or over 2000 chars)',
    (reason) => {
      expect(SUPPORT_REQUEST_TEXT_MAX).toBe(2000);
      expectCode(
        () => deregister({ reason }),
        DomainValidationError,
        'support-request-reason-invalid',
      );
    },
  );

  it.each(['', 'x'.repeat(2001)])('rejects evidence %j', (evidence) => {
    expectCode(
      () => deregister({ evidence }),
      DomainValidationError,
      'support-request-evidence-invalid',
    );
  });

  it('accepts reason and evidence of exactly 2000 chars', () => {
    const r = deregister({
      reason: 'x'.repeat(2000),
      evidence: 'y'.repeat(2000),
    });
    expect(r.reason).toHaveLength(2000);
  });

  it('created approved (execute alone): decided by the requester, still pending until executed', () => {
    const r = deregister({ requestedBy: ADMIN, approvedOnCreation: true });
    expect(r.decidedBy).toBe(ADMIN);
    expect(r.decidedAt).toEqual(NOW);
    expect(r.isApproved).toBe(true);
    r.markExecuted(later(1));
    expect(r.status).toBe('executed');
    expect(r.executedAt).toEqual(later(1));
  });

  describe('approve', () => {
    it('records the decider; executed or failed comes after', () => {
      const r = deregister();
      r.approve(ADMIN, later(DAY));
      expect(r.decidedBy).toBe(ADMIN);
      expect(r.decidedAt).toEqual(later(DAY));
      expect(r.isApproved).toBe(true);
      r.markFailed('hub-not-found');
      expect(r.status).toBe('failed');
      expect(r.failureType).toBe('hub-not-found');
      expect(r.executedAt).toBeNull();
    });

    it('the requester never approves their own request (self-approval)', () => {
      const r = deregister();
      expectCode(
        () => r.approve(SUPPORT, later(1)),
        DomainValidationError,
        'self-approval',
      );
      expect(r.status).toBe('pending');
      expect(r.decidedBy).toBeNull();
    });

    it('at or past the deadline: support-request-expired and the request becomes expired', () => {
      const r = deregister();
      expectCode(
        () => r.approve(ADMIN, r.expiresAt),
        DomainValidationError,
        'support-request-expired',
      );
      expect(r.status).toBe('expired');
      expect(r.decidedBy).toBeNull();
    });

    it('not pending: support-request-not-pending (409)', () => {
      const r = deregister();
      r.approve(ADMIN, later(1));
      r.markExecuted(later(1));
      expectCode(
        () => r.approve(ADMIN, later(2)),
        ConflictError,
        'support-request-not-pending',
      );
    });

    it('already approved (not yet executed) cannot be approved again', () => {
      const r = deregister();
      r.approve(ADMIN, later(1));
      expectCode(
        () => r.approve(ADMIN, later(2)),
        ConflictError,
        'support-request-not-pending',
      );
    });
  });

  describe('reject', () => {
    it('rejects with a note', () => {
      const r = deregister();
      r.reject(ADMIN, 'Evidence does not match', later(1));
      expect(r.status).toBe('rejected');
      expect(r.decidedBy).toBe(ADMIN);
      expect(r.decisionNote).toBe('Evidence does not match');
    });

    it.each(['', '  ', 'x'.repeat(2001)])(
      'requires a note of 1..2000 chars (%j)',
      (note) => {
        const r = deregister();
        expectCode(
          () => r.reject(ADMIN, note, later(1)),
          DomainValidationError,
          'decision-note-invalid',
        );
        expect(r.status).toBe('pending');
      },
    );

    it('same rules as approve: self-approval, expired, not pending', () => {
      expectCode(
        () => deregister().reject(SUPPORT, 'n', later(1)),
        DomainValidationError,
        'self-approval',
      );
      const expired = deregister();
      expectCode(
        () => expired.reject(ADMIN, 'n', later(8 * DAY)),
        DomainValidationError,
        'support-request-expired',
      );
      expect(expired.status).toBe('expired');
      const done = deregister();
      done.reject(ADMIN, 'n', later(1));
      expectCode(
        () => done.reject(ADMIN, 'n', later(2)),
        ConflictError,
        'support-request-not-pending',
      );
    });
  });

  describe('expireIfDue', () => {
    it('pending at or past the deadline becomes expired (true); otherwise nothing (false)', () => {
      const r = deregister();
      expect(r.expireIfDue(later(DAY))).toBe(false);
      expect(r.status).toBe('pending');
      expect(r.expireIfDue(r.expiresAt)).toBe(true);
      expect(r.status).toBe('expired');
      expect(r.expireIfDue(later(10 * DAY))).toBe(false);
    });

    it('an approved request waiting for execution never expires', () => {
      const r = deregister();
      r.approve(ADMIN, later(1));
      expect(r.expireIfDue(later(10 * DAY))).toBe(false);
    });

    it('a stored expired request answers support-request-expired on a decision', () => {
      const r = deregister();
      r.expireIfDue(later(8 * DAY));
      expectCode(
        () => r.approve(ADMIN, later(8 * DAY)),
        DomainValidationError,
        'support-request-expired',
      );
    });
  });

  describe('rejectForLostPermission', () => {
    it('a pending request is rejected by nobody, with the requester_lost_permission note', () => {
      const r = deregister();
      expect(r.rejectForLostPermission(later(DAY))).toBe('rejected');
      expect(r.status).toBe('rejected');
      expect(r.decidedBy).toBeNull();
      expect(r.decidedAt).toEqual(later(DAY));
      expect(r.decisionNote).toBe(REQUESTER_LOST_PERMISSION);
      expect(REQUESTER_LOST_PERMISSION).toBe('requester_lost_permission');
    });

    it('a due one becomes expired instead', () => {
      const r = deregister();
      expect(r.rejectForLostPermission(later(8 * DAY))).toBe('expired');
      expect(r.status).toBe('expired');
      expect(r.decisionNote).toBeNull();
    });

    it('a decided or approved request: support-request-not-pending (409)', () => {
      const rejected = deregister();
      rejected.reject(ADMIN, 'no', later(1));
      expect(() => rejected.rejectForLostPermission(later(2))).toThrow(
        ConflictError,
      );
      const approved = deregister();
      approved.approve(ADMIN, later(1));
      expect(() => approved.rejectForLostPermission(later(2))).toThrow(
        ConflictError,
      );
    });
  });

  it('markExecuted / markFailed need an approved pending request', () => {
    expect(() => deregister().markExecuted(NOW)).toThrow(ConflictError);
    expect(() => deregister().markFailed('x')).toThrow(ConflictError);
  });
});
