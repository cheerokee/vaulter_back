import { DomainValidationError } from '../../shared/domain/errors.js';
import { Organization } from './organization.js';
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
    expect(org.recoveryPublicKey).toBeNull();
    expect(org.createdAt).toEqual(now);
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

  it('registers the recovery key, then replaces it', () => {
    const org = Organization.create({ name: 'A', now });
    expect(org.setRecoveryKey(key)).toBe('registered');
    expect(org.recoveryPublicKey).toBe(key);
    expect(org.setRecoveryKey(key2)).toBe('replaced');
    expect(org.recoveryPublicKey).toBe(key2);
  });

  it('keeps the old key when the new one is invalid', () => {
    const org = Organization.create({ name: 'A', now });
    org.setRecoveryKey(key);
    expect(() => org.setRecoveryKey('xx')).toThrow(DomainValidationError);
    expect(org.recoveryPublicKey).toBe(key);
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
      plan: 'free',
      recoveryPublicKey: null,
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
