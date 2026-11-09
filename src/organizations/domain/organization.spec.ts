import { DomainValidationError } from '../../shared/domain/errors.js';
import {
  Organization,
  PLATFORM_APPOINTMENT_NOTICE_DAYS,
  PLATFORM_APPOINTMENT_PROTECTION_DAYS,
} from './organization.js';
import { assertRecoveryPublicKey } from './recovery-key.js';

const now = new Date('2026-10-25T10:00:00Z');
const key = Buffer.alloc(32, 7).toString('base64url');
const key2 = Buffer.alloc(32, 9).toString('base64url');

describe('Organization', () => {
  it('creates a regular organization with defaults', () => {
    const org = Organization.create({ name: '  Acme  ', now });
    expect(org.name).toBe('Acme');
    expect(org.isPersonal).toBe(false);
    expect(org.personalOwnerUserId).toBeNull();
    expect(org.plan).toBe('free');
    expect(org.hubLinkPolicy).toBe('any_member_hub');
    expect(org.allowRoomSpaces).toBe(true);
    expect(org.recoveryPublicKey).toBeNull();
    expect(org.createdAt).toEqual(now);
  });

  it('allows room spaces by default and toggles the policy', () => {
    const org = Organization.create({ name: 'A', now });
    org.setAllowRoomSpaces(false);
    expect(org.allowRoomSpaces).toBe(false);
    org.setAllowRoomSpaces(true);
    expect(org.allowRoomSpaces).toBe(true);
    expect(() => org.setAllowRoomSpaces('yes' as never)).toThrow(
      DomainValidationError,
    );
    expect(
      Organization.createPersonal({ name: 'P', ownerId: 'u1', now })
        .allowRoomSpaces,
    ).toBe(true);
  });

  it('creates a personal organization bound to its owner', () => {
    const org = Organization.createPersonal({
      name: 'Ana',
      ownerId: 'u1',
      now,
    });
    expect(org.isPersonal).toBe(true);
    expect(org.personalOwnerUserId).toBe('u1');
  });

  it('enforces name limits (1..255 after trim)', () => {
    const bad = (name: string) => () => Organization.create({ name, now });
    expect(bad('   ')).toThrow(DomainValidationError);
    expect(bad('')).toThrow(DomainValidationError);
    expect(bad('a'.repeat(256))).toThrow(DomainValidationError);
    expect(
      Organization.create({ name: 'a'.repeat(255), now }).name,
    ).toHaveLength(255);
    try {
      bad('')();
    } catch (e) {
      expect((e as DomainValidationError).code).toBe(
        'organization-name-invalid',
      );
    }
  });

  it('renames with the same rules', () => {
    const org = Organization.create({ name: 'A', now });
    org.rename(' B ');
    expect(org.name).toBe('B');
    expect(() => org.rename('')).toThrow(DomainValidationError);
    expect(org.name).toBe('B');
  });

  it('sets the hub link policy and rejects unknown values', () => {
    const org = Organization.create({ name: 'A', now });
    org.setHubLinkPolicy('admin_approved');
    expect(org.hubLinkPolicy).toBe('admin_approved');
    expect(() => org.setHubLinkPolicy('nope' as never)).toThrow(
      DomainValidationError,
    );
  });

  it('registers the recovery key, then replaces it, recording who changed it and when', () => {
    const org = Organization.create({ name: 'A', now });
    expect(org.recoveryKeyChangedAt).toBeNull();
    expect(org.recoveryKeyChangedByUserId).toBeNull();
    expect(org.setRecoveryKey(key, { userId: 'u1', now })).toBe('registered');
    expect(org.recoveryPublicKey).toBe(key);
    expect(org.recoveryKeyChangedAt).toEqual(now);
    expect(org.recoveryKeyChangedByUserId).toBe('u1');
    const later = new Date(now.getTime() + 60_000);
    expect(org.setRecoveryKey(key2, { userId: 'u2', now: later })).toBe(
      'replaced',
    );
    expect(org.recoveryPublicKey).toBe(key2);
    expect(org.recoveryKeyChangedAt).toEqual(later);
    expect(org.recoveryKeyChangedByUserId).toBe('u2');
  });

  it('keeps the old key (and who changed it) when the new one is invalid', () => {
    const org = Organization.create({ name: 'A', now });
    org.setRecoveryKey(key, { userId: 'u1', now });
    expect(() =>
      org.setRecoveryKey('xx', { userId: 'u2', now: new Date() }),
    ).toThrow(DomainValidationError);
    expect(org.recoveryPublicKey).toBe(key);
    expect(org.recoveryKeyChangedByUserId).toBe('u1');
    expect(org.recoveryKeyChangedAt).toEqual(now);
  });
});

describe('Organization protection after a platform appointment', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

  it('is never under protection without an appointment', () => {
    const org = Organization.create({ name: 'A', now });
    expect(org.platformAppointment).toBeNull();
    expect(org.isUnderProtection(now)).toBe(false);
    expect(() => org.assertNotUnderProtection(now)).not.toThrow();
    expect(org.platformAppointmentNotice(now)).toBeNull();
  });

  it(`records the appointment with a ${PLATFORM_APPOINTMENT_PROTECTION_DAYS}-day window`, () => {
    expect(PLATFORM_APPOINTMENT_PROTECTION_DAYS).toBe(7);
    const org = Organization.create({ name: 'A', now });
    org.recordPlatformAppointment('u9', now);
    expect(org.platformAppointment).toEqual({
      appointedUserId: 'u9',
      appointedAt: now,
      protectedUntil: plus(now, 7 * DAY),
    });
  });

  it('blocks before protectedUntil and allows at and after it', () => {
    const org = Organization.create({ name: 'A', now });
    org.recordPlatformAppointment('u9', now);
    const until = plus(now, 7 * DAY);
    for (const t of [now, plus(now, DAY), plus(until, -1)]) {
      expect(org.isUnderProtection(t)).toBe(true);
      const err = (() => {
        try {
          org.assertNotUnderProtection(t);
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(DomainValidationError);
      expect(err).toMatchObject({
        code: 'organization-under-protection',
        details: { protectedUntil: until.toISOString() },
      });
    }
    for (const t of [until, plus(until, 1), plus(until, 30 * DAY)]) {
      expect(org.isUnderProtection(t)).toBe(false);
      expect(() => org.assertNotUnderProtection(t)).not.toThrow();
    }
  });

  it('setRecoveryKey itself refuses during the window (no caller can bypass it), keeping the old key', () => {
    const org = Organization.create({ name: 'A', now });
    org.setRecoveryKey(key, { userId: 'u1', now });
    org.recordPlatformAppointment('u9', now);
    for (const k of [key2, 'xx']) {
      expect(() =>
        org.setRecoveryKey(k, { userId: 'u9', now: plus(now, DAY) }),
      ).toThrow(
        expect.objectContaining({ code: 'organization-under-protection' }),
      );
    }
    expect(org.recoveryPublicKey).toBe(key);
    expect(org.recoveryKeyChangedByUserId).toBe('u1');
    expect(
      org.setRecoveryKey(key2, { userId: 'u9', now: plus(now, 7 * DAY) }),
    ).toBe('replaced');
  });

  it('a new appointment restarts the window (overwrites the three fields)', () => {
    const org = Organization.create({ name: 'A', now });
    org.recordPlatformAppointment('u9', now);
    const later = plus(now, 6 * DAY);
    org.recordPlatformAppointment('u8', later);
    expect(org.platformAppointment).toEqual({
      appointedUserId: 'u8',
      appointedAt: later,
      protectedUntil: plus(later, 7 * DAY),
    });
    expect(org.isUnderProtection(plus(now, 8 * DAY))).toBe(true);
  });

  it(`the notice stays visible until protectedUntil + ${PLATFORM_APPOINTMENT_NOTICE_DAYS} days, then is null`, () => {
    expect(PLATFORM_APPOINTMENT_NOTICE_DAYS).toBe(30);
    const org = Organization.create({ name: 'A', now });
    org.recordPlatformAppointment('u9', now);
    const until = plus(now, 7 * DAY);
    const end = plus(until, 30 * DAY);
    expect(org.platformAppointmentNotice(now)).toEqual(org.platformAppointment);
    expect(org.platformAppointmentNotice(until)).toEqual(
      org.platformAppointment,
    );
    expect(org.platformAppointmentNotice(plus(end, -1))).toEqual(
      org.platformAppointment,
    );
    expect(org.platformAppointmentNotice(end)).toBeNull();
    // the stored appointment itself is kept (history)
    expect(org.platformAppointment).not.toBeNull();
  });
});

describe('Organization derived flags', () => {
  it('knows its personal owner', () => {
    const p = Organization.createPersonal({ name: 'Ana', ownerId: 'u1', now });
    expect(p.isPersonalOwner('u1')).toBe(true);
    expect(p.isPersonalOwner('u2')).toBe(false);
    expect(Organization.create({ name: 'A', now }).isPersonalOwner('u1')).toBe(
      false,
    );
  });

  it('restore rejects inconsistent personal data', () => {
    const base = {
      name: 'A',
      hubLinkPolicy: 'any_member_hub' as const,
      allowRoomSpaces: true,
      plan: 'free',
      recoveryPublicKey: null,
      recoveryKeyChangedAt: null,
      recoveryKeyChangedByUserId: null,
      platformAppointment: null,
    };
    expect(() =>
      Organization.restore(
        { ...base, isPersonal: true, personalOwnerUserId: null },
        'o1',
      ),
    ).toThrow(/inconsistent/);
    expect(() =>
      Organization.restore(
        { ...base, isPersonal: false, personalOwnerUserId: 'u1' },
        'o1',
      ),
    ).toThrow(/inconsistent/);
    expect(
      Organization.restore(
        { ...base, isPersonal: true, personalOwnerUserId: 'u1' },
        'o1',
      ).isPersonal,
    ).toBe(true);
  });
});

describe('assertRecoveryPublicKey', () => {
  it('accepts strict 32-byte base64url', () => {
    expect(assertRecoveryPublicKey(key)).toBe(key);
  });
  it.each([
    ['wrong length', Buffer.alloc(31).toString('base64url')],
    ['padding', Buffer.alloc(32).toString('base64')],
    ['non canonical', key.slice(0, -1) + 'B'],
    ['empty', ''],
    ['not a string', 5 as unknown as string],
  ])('rejects %s', (_n, v) => {
    try {
      assertRecoveryPublicKey(v);
      expect.unreachable();
    } catch (e) {
      expect((e as DomainValidationError).code).toBe(
        'recovery-public-key-invalid',
      );
    }
  });
});
