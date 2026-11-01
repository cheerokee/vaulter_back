import { DomainValidationError } from '../../shared/domain/errors.js';
import {
  CLAIM_CODE_PATTERN,
  claimCodeInvalid,
  Enrollment,
  ENROLLMENT_TTL_MS,
} from './enrollment.js';
import { Hub } from './hub.js';

const keys = {
  signingPublicKey: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
  encryptionPublicKey: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI',
};
const now = new Date('2026-11-01T12:00:00Z');
const issue = () => Enrollment.issue({ keys, nonce: 'n', codeHash: 'h', now });

describe('Enrollment', () => {
  it('issues a pending enrollment valid for 10 minutes', () => {
    const e = issue();
    expect(e.status).toBe('pending');
    expect(e.expiresAt.getTime() - now.getTime()).toBe(ENROLLMENT_TTL_MS);
    expect(ENROLLMENT_TTL_MS).toBe(600_000);
  });

  it('rejects invalid keys', () => {
    expect(() =>
      Enrollment.issue({
        keys: { ...keys, signingPublicKey: 'bad' },
        nonce: 'n',
        codeHash: 'h',
        now,
      }),
    ).toThrow(expect.objectContaining({ code: 'signing-public-key-invalid' }));
    expect(() =>
      Enrollment.issue({
        keys: { ...keys, encryptionPublicKey: 'bad' },
        nonce: 'n',
        codeHash: 'h',
        now,
      }),
    ).toThrow(
      expect.objectContaining({ code: 'encryption-public-key-invalid' }),
    );
  });

  it('rejects an empty nonce', () => {
    expect(() =>
      Enrollment.issue({ keys, nonce: '', codeHash: 'h', now }),
    ).toThrow(expect.objectContaining({ code: 'nonce-invalid' }));
  });

  it('is claimable before expiry', () => {
    expect(() =>
      issue().assertClaimable(new Date(now.getTime() + 1000)),
    ).not.toThrow();
  });

  it('gives the same error for expired and claimed', () => {
    const expired = issue();
    expect(() =>
      expired.assertClaimable(new Date(now.getTime() + ENROLLMENT_TTL_MS)),
    ).toThrow(expect.objectContaining({ code: 'claim-code-invalid' }));
    const claimed = issue();
    claimed.markClaimed('hub-1');
    expect(claimed.claimedHubId).toBe('hub-1');
    expect(() => claimed.assertClaimable(now)).toThrow(
      expect.objectContaining({ code: 'claim-code-invalid' }),
    );
  });
});

describe('claim code', () => {
  it('is 8 digits and its single error is a 422 claim-code-invalid', () => {
    expect(CLAIM_CODE_PATTERN.test('01234567')).toBe(true);
    expect(CLAIM_CODE_PATTERN.test('0123456')).toBe(false);
    expect(CLAIM_CODE_PATTERN.test('0123456a')).toBe(false);
    const error = claimCodeInvalid();
    expect(error).toBeInstanceOf(DomainValidationError);
    expect(error.code).toBe('claim-code-invalid');
    expect(() =>
      issue().assertClaimable(new Date(now.getTime() + ENROLLMENT_TTL_MS)),
    ).toThrow(DomainValidationError);
  });
});

describe('Hub', () => {
  it('claims from a claimable enrollment, copying its keys', () => {
    const hub = Hub.claim({
      enrollment: issue(),
      ownerUserId: 'u1',
      name: '  Kitchen ',
      now,
    });
    expect(hub.name).toBe('Kitchen');
    expect(hub.ownerUserId).toBe('u1');
    expect(hub.signingPublicKey).toBe(keys.signingPublicKey);
    expect(hub.encryptionPublicKey).toBe(keys.encryptionPublicKey);
    expect(hub.lastSeenAt).toBeNull();
    expect(hub.isDeregistered).toBe(false);
  });

  it('refuses a non-claimable enrollment and bad names', () => {
    const late = new Date(now.getTime() + ENROLLMENT_TTL_MS);
    expect(() =>
      Hub.claim({
        enrollment: issue(),
        ownerUserId: 'u',
        name: 'x',
        now: late,
      }),
    ).toThrow(expect.objectContaining({ code: 'claim-code-invalid' }));
    for (const name of ['', '   ', 'a'.repeat(256)]) {
      expect(() =>
        Hub.claim({ enrollment: issue(), ownerUserId: 'u', name, now }),
      ).toThrow(expect.objectContaining({ code: 'hub-name-invalid' }));
    }
  });

  it('renames, touches and deregisters (keeping the first deregistration date)', () => {
    const hub = Hub.claim({
      enrollment: issue(),
      ownerUserId: 'u',
      name: 'a',
      now,
    });
    hub.rename(' b ');
    expect(hub.name).toBe('b');
    expect(() => hub.rename('')).toThrow(
      expect.objectContaining({ code: 'hub-name-invalid' }),
    );
    const t = new Date(now.getTime() + 5000);
    hub.touch(t);
    expect(hub.lastSeenAt).toEqual(t);
    hub.deregister(t);
    hub.deregister(new Date(t.getTime() + 1000));
    expect(hub.isDeregistered).toBe(true);
    expect(hub.deletedAt).toEqual(t);
  });
});
