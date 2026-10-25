import { DomainValidationError } from '../../shared/domain/errors.js';
import { INVITATION_TTL_DAYS, Invitation } from './invitation.js';

const now = new Date('2026-10-25T10:00:00Z');
const base = {
  organizationId: 'o1',
  roleKey: 'org_member' as const,
  createdBy: 'u1',
  tokenHash: 'abc123',
  now,
};
const day = 86_400_000;

describe('Invitation', () => {
  it('issues a pending invitation expiring in 7 days', () => {
    const inv = Invitation.issue(base);
    expect(INVITATION_TTL_DAYS).toBe(7);
    expect(inv.status).toBe('pending');
    expect(inv.expiresAt).toEqual(new Date(now.getTime() + 7 * day));
    expect(inv.email).toBeNull();
    expect(inv.tokenHash).toBe('abc123');
  });

  it('never exposes a raw token', () => {
    const inv = Invitation.issue(base);
    expect('token' in inv).toBe(false);
    expect(JSON.stringify(inv)).not.toMatch(/"token"/);
  });

  it('normalizes the e-mail and validates the role', () => {
    expect(
      Invitation.issue({ ...base, email: '  Ana@Example.COM ' }).email,
    ).toBe('ana@example.com');
    expect(() =>
      Invitation.issue({ ...base, roleKey: 'hub_owner' as never }),
    ).toThrow(DomainValidationError);
    expect(() => Invitation.issue({ ...base, tokenHash: '' })).toThrow(
      DomainValidationError,
    );
  });

  it('can be accepted while pending and not expired', () => {
    const inv = Invitation.issue(base);
    expect(inv.canBeAcceptedBy('x@y.com', now)).toBe(true);
    expect(
      inv.canBeAcceptedBy('x@y.com', new Date(now.getTime() + 7 * day - 1)),
    ).toBe(true);
  });

  it('is not acceptable once expired (boundary included)', () => {
    const inv = Invitation.issue(base);
    const at = new Date(now.getTime() + 7 * day);
    expect(inv.canBeAcceptedBy('x@y.com', at)).toBe(false);
    expect(inv.effectiveStatus(at)).toBe('expired');
    expect(inv.effectiveStatus(now)).toBe('pending');
  });

  it('matches e-mail after normalization when set', () => {
    const inv = Invitation.issue({ ...base, email: 'ana@example.com' });
    expect(inv.canBeAcceptedBy(' ANA@example.com ', now)).toBe(true);
    expect(inv.canBeAcceptedBy('bob@example.com', now)).toBe(false);
  });

  it('transitions: accept and revoke are single-use', () => {
    const a = Invitation.issue(base);
    a.accept('u2', now, null);
    expect(a.status).toBe('accepted');
    expect(a.acceptedBy).toBe('u2');
    expect(a.canBeAcceptedBy('x@y.com', now)).toBe(false);
    expect(() => a.accept('u3', now, null)).toThrow(DomainValidationError);
    expect(() => a.revoke()).toThrow(DomainValidationError);

    const r = Invitation.issue(base);
    r.revoke();
    expect(r.status).toBe('revoked');
    expect(r.canBeAcceptedBy('x@y.com', now)).toBe(false);
    expect(() => r.accept('u2', now, null)).toThrow(DomainValidationError);
  });

  it('requires an account e-mail when the invitation has one', () => {
    const inv = Invitation.issue({ ...base, email: 'ana@example.com' });
    expect(inv.canBeAcceptedBy(null, now)).toBe(false);
    expect(() => inv.accept('u2', now, null)).toThrow(DomainValidationError);
  });

  it('refuses to accept when the e-mail does not match', () => {
    const inv = Invitation.issue({ ...base, email: 'ana@example.com' });
    expect(() => inv.accept('u2', now, 'bob@example.com')).toThrow(
      DomainValidationError,
    );
    inv.accept('u2', now, 'ANA@example.com');
    expect(inv.status).toBe('accepted');
  });
});
