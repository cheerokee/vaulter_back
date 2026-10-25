import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';
import {
  ADMIN,
  BAD_WK,
  EDITOR,
  KIT_PK,
  MANAGER,
  OLD_KIT_PK,
  ORG_ID,
  OTHER_ADMIN,
  OUTSIDER,
  PROOF,
  READER,
  SPACE_ID,
  actor,
  fp,
  makeSpaceKit,
  wk,
} from '../../../test/support/spaces-kit.js';
import { GetMyKeysUseCase } from './get-my-keys.use-case.js';
import { GetRecoveryCopiesUseCase } from './get-recovery-copies.use-case.js';
import { RecoverOrphanSpaceUseCase } from './recover-orphan-space.use-case.js';
import { RewrapRecoveryUseCase } from './rewrap-recovery.use-case.js';
import { RotateSpaceKeyUseCase } from './rotate-space-key.use-case.js';
import type { SpaceRoleKey } from '../domain/space-membership.js';
import { Space } from '../domain/space.js';

const kit = makeSpaceKit();
const d = kit.deps;
const m = kit.mocks;
const NOT_FOUND = { constructor: NotFoundError, code: 'space-not-found' };
const kId = (v: number) => `${SPACE_ID.slice(-3)}-k${v}`;

beforeEach(() => {
  vi.resetAllMocks();
  kit.reset();
});

describe('GetMyKeysUseCase', () => {
  const useCase = () => new GetMyKeysUseCase(d.access, d.grants);

  it('returns my copies of every version and the current version', async () => {
    kit.addSpace(SPACE_ID, ORG_ID, [[READER, 'space_reader']], { version: 2 });
    m.grants.forUser.mockResolvedValue([
      { spaceKeyId: kId(1), version: 1, wrappedKey: wk(1) },
      { spaceKeyId: kId(2), version: 2, wrappedKey: wk(2) },
    ]);
    await expect(useCase().execute(actor(READER), SPACE_ID)).resolves.toEqual({
      currentVersion: 2,
      keys: [
        { version: 1, wrappedKey: wk(1) },
        { version: 2, wrappedKey: wk(2) },
      ],
    });
    expect(m.grants.forUser).toHaveBeenCalledWith(ORG_ID, SPACE_ID, READER);
  });

  it('the org admin outside the space gets 404 and no key is read', async () => {
    await expect(
      useCase().execute(actor(ADMIN), SPACE_ID),
    ).rejects.toMatchObject(NOT_FOUND);
    expect(m.grants.forUser).not.toHaveBeenCalled();
  });
});

describe('RotateSpaceKeyUseCase', () => {
  const useCase = () =>
    new RotateSpaceKeyUseCase(
      d.access,
      d.recoveryKit,
      d.spaces,
      d.keys,
      d.grants,
      d.roles,
      d.audit,
      d.uow,
    );
  const allGrants = [MANAGER, EDITOR, READER].map((userId, i) => ({
    userId,
    wrappedKey: wk(10 + i),
  }));
  const input = {
    version: 2,
    recoveryPublicKey: KIT_PK,
    recoveryWrappedKey: wk(20),
    grants: allGrants,
  };
  const members: [string, SpaceRoleKey][] = [
    [MANAGER, 'space_manager'],
    [EDITOR, 'space_editor'],
    [READER, 'space_reader'],
  ];
  // Default for this block: a rotation is pending (someone left), so any member may rotate.
  beforeEach(() => kit.addSpace(SPACE_ID, ORG_ID, members, { rotation: true }));

  it('no rotation pending: a reader or editor gets 409 key-rotation-not-required, nothing written', async () => {
    kit.addSpace(SPACE_ID, ORG_ID, members);
    for (const who of [READER, EDITOR]) {
      await expect(
        useCase().execute(actor(who), SPACE_ID, input),
      ).rejects.toMatchObject({
        constructor: ConflictError,
        code: 'key-rotation-not-required',
      });
    }
    expect(m.keys.addVersion).not.toHaveBeenCalled();
    expect(m.grants.upsert).not.toHaveBeenCalled();
    expect(m.spaces.save).not.toHaveBeenCalled();
    expect(m.audit.record).not.toHaveBeenCalled();
  });

  it('no rotation pending: a manager may rotate manually (e.g. suspected leak)', async () => {
    kit.addSpace(SPACE_ID, ORG_ID, members);
    await expect(
      useCase().execute(actor(MANAGER), SPACE_ID, input),
    ).resolves.toEqual({ currentVersion: 2 });
    expect(m.keys.addVersion).toHaveBeenCalledTimes(1);
  });

  it('the pending flag is read from the LOCKED space (authoritative)', async () => {
    kit.addSpace(SPACE_ID, ORG_ID, members);
    // Pre-check sees a pending rotation, the locked row no longer has it (someone rotated meanwhile).
    m.spaces.findById.mockImplementationOnce(async () =>
      Space.restore(
        {
          organizationId: ORG_ID,
          name: 'Manuais',
          currentKeyVersion: 1,
          keyRotationRequired: true,
        },
        SPACE_ID,
      ),
    );
    await expect(
      useCase().execute(actor(READER), SPACE_ID, input),
    ).rejects.toMatchObject({ code: 'key-rotation-not-required' });
  });

  it('any member rotates: new version with the org fingerprint, a copy per member, flag cleared, audited', async () => {
    kit.addSpace(
      SPACE_ID,
      ORG_ID,
      [
        [MANAGER, 'space_manager'],
        [EDITOR, 'space_editor'],
        [READER, 'space_reader'],
      ],
      { rotation: true },
    );
    await expect(
      useCase().execute(actor(READER), SPACE_ID, input),
    ).resolves.toEqual({
      currentVersion: 2,
    });
    expect(m.keys.addVersion).toHaveBeenCalledWith(
      ORG_ID,
      SPACE_ID,
      2,
      wk(20),
      fp(KIT_PK),
    );
    for (const g of allGrants) {
      expect(m.grants.upsert).toHaveBeenCalledWith(
        ORG_ID,
        kId(2),
        g.userId,
        g.wrappedKey,
      );
    }
    const saved = kit.spacesById.get(SPACE_ID)!;
    expect(saved.currentKeyVersion).toBe(2);
    expect(saved.keyRotationRequired).toBe(false);
    const lock = kit.trace.indexOf('spaces.lockForUpdate');
    expect(kit.trace.indexOf('roles.activeMemberIds')).toBeGreaterThan(lock);
    expect(kit.trace.indexOf('keys.addVersion')).toBeGreaterThan(lock);
    expect(kit.audited()).toEqual([
      {
        organizationId: ORG_ID,
        userId: READER,
        action: 'space.key_rotated',
        metadata: { spaceId: SPACE_ID, version: 2 },
      },
    ]);
    for (const n of [10, 11, 12, 20])
      expect(kit.auditDump()).not.toContain(wk(n));
  });

  it('version must be current + 1 (409 key-rotation-mismatch)', async () => {
    for (const version of [1, 3]) {
      await expect(
        useCase().execute(actor(READER), SPACE_ID, { ...input, version }),
      ).rejects.toMatchObject({
        constructor: ConflictError,
        code: 'key-rotation-mismatch',
      });
    }
    expect(m.keys.addVersion).not.toHaveBeenCalled();
  });

  it('grants must be exactly the active members: missing, extra (someone who left) or duplicated -> 409', async () => {
    for (const grants of [
      allGrants.slice(0, 2),
      [...allGrants, { userId: OUTSIDER, wrappedKey: wk(13) }],
      [...allGrants.slice(0, 2), allGrants[0]!],
    ]) {
      await expect(
        useCase().execute(actor(READER), SPACE_ID, { ...input, grants }),
      ).rejects.toMatchObject({
        constructor: ConflictError,
        code: 'key-rotation-mismatch',
      });
    }
    expect(m.keys.addVersion).not.toHaveBeenCalled();
    expect(m.grants.upsert).not.toHaveBeenCalled();
  });

  it('kit changed meanwhile: 409 recovery-key-changed; no kit: 422 recovery-key-required', async () => {
    await expect(
      useCase().execute(actor(READER), SPACE_ID, {
        ...input,
        recoveryPublicKey: OLD_KIT_PK,
      }),
    ).rejects.toMatchObject({
      constructor: ConflictError,
      code: 'recovery-key-changed',
    });
    kit.kits.set(ORG_ID, null);
    await expect(
      useCase().execute(actor(READER), SPACE_ID, input),
    ).rejects.toMatchObject({
      constructor: DomainValidationError,
      code: 'recovery-key-required',
    });
    expect(m.keys.addVersion).not.toHaveBeenCalled();
  });

  it('the org admin outside the space gets 404 before the kit is checked', async () => {
    await expect(
      useCase().execute(actor(ADMIN), SPACE_ID, {
        ...input,
        recoveryPublicKey: OLD_KIT_PK,
      }),
    ).rejects.toMatchObject(NOT_FOUND);
    expect(m.spaces.lockForUpdate).not.toHaveBeenCalled();
  });

  it('invalid wrapped keys or recovery key: 422 before the unit of work', async () => {
    for (const bad of [
      { ...input, recoveryWrappedKey: BAD_WK },
      { ...input, grants: [{ userId: MANAGER, wrappedKey: 'x' }] },
      { ...input, recoveryPublicKey: 'x' },
    ]) {
      await expect(
        useCase().execute(actor(READER), SPACE_ID, bad),
      ).rejects.toBeInstanceOf(DomainValidationError);
    }
    expect(m.uow.run).not.toHaveBeenCalled();
  });
});

describe('RewrapRecoveryUseCase', () => {
  const useCase = () =>
    new RewrapRecoveryUseCase(d.access, d.recoveryKit, d.keys, d.audit, d.uow);
  const staleSpace = () =>
    kit.addSpace(SPACE_ID, ORG_ID, [[READER, 'space_reader']], {
      version: 3,
      fingerprints: [fp(OLD_KIT_PK), fp(KIT_PK), fp(OLD_KIT_PK)],
    });

  it('rewraps exactly the stale versions with the current kit fingerprint; audited without keys', async () => {
    staleSpace();
    const versions = [
      { version: 3, wrappedKey: wk(33) },
      { version: 1, wrappedKey: wk(31) },
    ];
    await expect(
      useCase().execute(actor(READER), SPACE_ID, {
        recoveryPublicKey: KIT_PK,
        versions,
      }),
    ).resolves.toEqual({ versions: [1, 3] });
    expect(m.keys.setRecoveryWrap).toHaveBeenCalledWith(
      ORG_ID,
      SPACE_ID,
      1,
      wk(31),
      fp(KIT_PK),
    );
    expect(m.keys.setRecoveryWrap).toHaveBeenCalledWith(
      ORG_ID,
      SPACE_ID,
      3,
      wk(33),
      fp(KIT_PK),
    );
    expect(m.keys.setRecoveryWrap).toHaveBeenCalledTimes(2);
    expect(kit.trace.indexOf('keys.versions')).toBeGreaterThan(
      kit.trace.indexOf('spaces.lockForUpdate'),
    );
    expect(kit.audited()).toEqual([
      {
        organizationId: ORG_ID,
        userId: READER,
        action: 'space.recovery_rewrapped',
        metadata: { spaceId: SPACE_ID, versions: [1, 3] },
      },
    ]);
    expect(kit.auditDump()).not.toContain(wk(31));
  });

  it('all versions are accepted too', async () => {
    staleSpace();
    const versions = [1, 2, 3].map((version) => ({
      version,
      wrappedKey: wk(30 + version),
    }));
    await useCase().execute(actor(READER), SPACE_ID, {
      recoveryPublicKey: KIT_PK,
      versions,
    });
    expect(m.keys.setRecoveryWrap).toHaveBeenCalledTimes(3);
  });

  it('any other set (partial, unknown, duplicated, empty) is 409 key-versions-mismatch', async () => {
    staleSpace();
    for (const vs of [[1], [1, 2], [1, 3, 4], [1, 1, 3], []]) {
      await expect(
        useCase().execute(actor(READER), SPACE_ID, {
          recoveryPublicKey: KIT_PK,
          versions: vs.map((version) => ({ version, wrappedKey: wk(40) })),
        }),
      ).rejects.toMatchObject({
        constructor: ConflictError,
        code: 'key-versions-mismatch',
      });
    }
    expect(m.keys.setRecoveryWrap).not.toHaveBeenCalled();
  });

  it('old kit: 409 recovery-key-changed; admin outside the space: 404; bad key 422', async () => {
    staleSpace();
    const versions = [{ version: 1, wrappedKey: wk(31) }];
    await expect(
      useCase().execute(actor(READER), SPACE_ID, {
        recoveryPublicKey: OLD_KIT_PK,
        versions,
      }),
    ).rejects.toMatchObject({ code: 'recovery-key-changed' });
    await expect(
      useCase().execute(actor(ADMIN), SPACE_ID, {
        recoveryPublicKey: KIT_PK,
        versions,
      }),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      useCase().execute(actor(READER), SPACE_ID, {
        recoveryPublicKey: KIT_PK,
        versions: [{ version: 1, wrappedKey: BAD_WK }],
      }),
    ).rejects.toMatchObject({ code: 'wrapped-key-invalid' });
  });
});

describe('RecoverOrphanSpaceUseCase', () => {
  const useCase = () =>
    new RecoverOrphanSpaceUseCase(
      d.access,
      d.verifier,
      d.keys,
      d.grants,
      d.roles,
      d.audit,
      d.uow,
    );
  const orphan = () => kit.addSpace(SPACE_ID, ORG_ID, [], { version: 2 });
  const input = {
    grants: [
      { version: 1, wrappedKey: wk(51) },
      { version: 2, wrappedKey: wk(52) },
    ],
    currentAuthProof: PROOF,
  };

  it('reauth before the unit of work; the admin enters as manager with copies of every version; audited', async () => {
    orphan();
    await expect(
      useCase().execute(actor(ADMIN), SPACE_ID, input),
    ).resolves.toEqual({
      roleKey: 'space_manager',
    });
    expect(m.verifier.verify).toHaveBeenCalledWith(ADMIN, PROOF);
    expect(kit.trace).toContain('verifier.verify@out');
    expect(m.grants.upsert).toHaveBeenCalledWith(ORG_ID, kId(1), ADMIN, wk(51));
    expect(m.grants.upsert).toHaveBeenCalledWith(ORG_ID, kId(2), ADMIN, wk(52));
    expect(kit.spaceRoles.get(SPACE_ID)!.get(ADMIN)).toBe('space_manager');
    const lock = kit.trace.indexOf('spaces.lockForUpdate');
    expect(kit.trace.indexOf('roles.activeMemberIds')).toBeGreaterThan(lock);
    expect(kit.audited()).toEqual([
      {
        organizationId: ORG_ID,
        userId: ADMIN,
        action: 'space.recovered_with_kit',
        metadata: { spaceId: SPACE_ID, versions: 2 },
      },
    ]);
    expect(kit.auditDump()).not.toContain(wk(51));
    expect(kit.auditDump()).not.toContain(PROOF);
  });

  it('a space with members: 409 space-not-orphan before the reauth (non-locking pre-check), nothing written', async () => {
    await expect(
      useCase().execute(actor(ADMIN), SPACE_ID, {
        ...input,
        grants: [{ version: 1, wrappedKey: wk(51) }],
      }),
    ).rejects.toMatchObject({
      constructor: ConflictError,
      code: 'space-not-orphan',
    });
    expect(m.grants.upsert).not.toHaveBeenCalled();
    expect(m.verifier.verify).not.toHaveBeenCalled();
    expect(m.uow.run).not.toHaveBeenCalled();
  });

  it('a member appearing between the pre-check and the lock: 409 under the lock (authoritative)', async () => {
    orphan();
    m.roles.activeMemberIds
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([READER]);
    await expect(
      useCase().execute(actor(ADMIN), SPACE_ID, input),
    ).rejects.toMatchObject({ code: 'space-not-orphan' });
    expect(m.verifier.verify).toHaveBeenCalled();
    expect(m.grants.upsert).not.toHaveBeenCalled();
  });

  it('grants must cover every version (409 key-versions-mismatch)', async () => {
    orphan();
    await expect(
      useCase().execute(actor(ADMIN), SPACE_ID, {
        ...input,
        grants: input.grants.slice(0, 1),
      }),
    ).rejects.toMatchObject({ code: 'key-versions-mismatch' });
    expect(m.roles.assign).not.toHaveBeenCalled();
  });

  it('wrong proof: the error propagates and no lock is taken', async () => {
    orphan();
    m.verifier.verify.mockRejectedValue(
      new DomainValidationError('current-auth-proof-invalid', 'x'),
    );
    await expect(
      useCase().execute(actor(ADMIN), SPACE_ID, input),
    ).rejects.toMatchObject({
      code: 'current-auth-proof-invalid',
    });
    expect(m.uow.run).not.toHaveBeenCalled();
  });

  it('needs org.members.manage: org member 404, other org admin 404 (no reauth spent)', async () => {
    orphan();
    for (const userId of [OUTSIDER, OTHER_ADMIN]) {
      await expect(
        useCase().execute(actor(userId), SPACE_ID, input),
      ).rejects.toMatchObject(NOT_FOUND);
    }
    expect(m.verifier.verify).not.toHaveBeenCalled();
  });

  it('a space member without the org permission gets 403', async () => {
    await expect(
      useCase().execute(actor(EDITOR), SPACE_ID, input),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('invalid wrapped key: 422 before anything else', async () => {
    await expect(
      useCase().execute(actor(ADMIN), SPACE_ID, {
        ...input,
        grants: [{ version: 1, wrappedKey: BAD_WK }],
      }),
    ).rejects.toMatchObject({ code: 'wrapped-key-invalid' });
    expect(m.verifier.verify).not.toHaveBeenCalled();
  });
});

describe('GetRecoveryCopiesUseCase', () => {
  const useCase = () =>
    new GetRecoveryCopiesUseCase(
      d.access,
      d.verifier,
      d.keys,
      d.roles,
      d.audit,
      d.uow,
    );
  const orphan = () =>
    kit.addSpace(SPACE_ID, ORG_ID, [], {
      version: 2,
      fingerprints: [fp(OLD_KIT_PK), fp(KIT_PK)],
    });
  const input = { currentAuthProof: PROOF };

  it('reauth before the unit of work; returns the kit copy of every version under the lock; audited without copies', async () => {
    orphan();
    await expect(
      useCase().execute(actor(ADMIN), SPACE_ID, input),
    ).resolves.toEqual({
      currentVersion: 2,
      copies: [
        {
          version: 1,
          recoveryWrappedKey: wk(90),
          recoveryKeyFingerprint: fp(OLD_KIT_PK),
        },
        {
          version: 2,
          recoveryWrappedKey: wk(91),
          recoveryKeyFingerprint: fp(KIT_PK),
        },
      ],
    });
    expect(m.verifier.verify).toHaveBeenCalledWith(ADMIN, PROOF);
    expect(kit.trace).toContain('verifier.verify@out');
    const lock = kit.trace.indexOf('spaces.lockForUpdate');
    expect(lock).toBeGreaterThan(kit.trace.indexOf('verifier.verify@out'));
    expect(kit.trace.lastIndexOf('roles.activeMemberIds')).toBeGreaterThan(
      lock,
    );
    expect(kit.trace.indexOf('keys.versions')).toBeGreaterThan(lock);
    expect(kit.audited()).toEqual([
      {
        organizationId: ORG_ID,
        userId: ADMIN,
        action: 'space.recovery_copies_read',
        metadata: { spaceId: SPACE_ID, versions: 2 },
      },
    ]);
    expect(kit.auditDump()).not.toContain(wk(90));
    expect(kit.auditDump()).not.toContain(PROOF);
    // read-only: nothing is written besides the audit
    expect(m.grants.upsert).not.toHaveBeenCalled();
    expect(m.roles.assign).not.toHaveBeenCalled();
  });

  it('a space with members: 409 space-not-orphan before the reauth (non-locking pre-check)', async () => {
    await expect(
      useCase().execute(actor(ADMIN), SPACE_ID, input),
    ).rejects.toMatchObject({
      constructor: ConflictError,
      code: 'space-not-orphan',
    });
    expect(m.verifier.verify).not.toHaveBeenCalled();
    expect(m.uow.run).not.toHaveBeenCalled();
    expect(m.keys.versions).not.toHaveBeenCalled();
  });

  it('a member appearing between the pre-check and the lock: 409 under the lock, no copy read', async () => {
    orphan();
    m.roles.activeMemberIds
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([READER]);
    await expect(
      useCase().execute(actor(ADMIN), SPACE_ID, input),
    ).rejects.toMatchObject({ code: 'space-not-orphan' });
    expect(m.verifier.verify).toHaveBeenCalled();
    expect(m.keys.versions).not.toHaveBeenCalled();
    expect(m.audit.record).not.toHaveBeenCalled();
  });

  it('wrong proof: the error propagates, nothing read', async () => {
    orphan();
    m.verifier.verify.mockRejectedValue(
      new DomainValidationError('current-auth-proof-invalid', 'x'),
    );
    await expect(
      useCase().execute(actor(ADMIN), SPACE_ID, input),
    ).rejects.toMatchObject({ code: 'current-auth-proof-invalid' });
    expect(m.uow.run).not.toHaveBeenCalled();
    expect(m.keys.versions).not.toHaveBeenCalled();
  });

  it('needs org.members.manage: org member and other org admin 404 (no reauth spent); space member without it 403', async () => {
    orphan();
    for (const userId of [OUTSIDER, OTHER_ADMIN]) {
      await expect(
        useCase().execute(actor(userId), SPACE_ID, input),
      ).rejects.toMatchObject(NOT_FOUND);
    }
    expect(m.verifier.verify).not.toHaveBeenCalled();
    kit.reset();
    await expect(
      useCase().execute(actor(EDITOR), SPACE_ID, input),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(m.verifier.verify).not.toHaveBeenCalled();
  });
});
