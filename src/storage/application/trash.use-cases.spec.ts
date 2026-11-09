import { QueryFailedError } from 'typeorm';
import type { CurrentAuthProofVerifier } from '../../identity/application/current-auth-proof-verifier.js';
import type { AuditLog } from '../../organizations/application/audit-log.js';
import {
  ConflictError,
  DomainValidationError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';
import type { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { BackupObject } from '../domain/backup-object.js';
import type { BackupObjectRepository } from '../domain/backup-object.repository.js';
import type { PurgedVersion } from '../domain/backup-object-version.js';
import type { BackupObjectVersionRepository } from '../domain/backup-object-version.repository.js';
import { MAX_PURGE_BATCH_VERSIONS } from '../domain/backup-limits.js';
import { BackupTrash } from './backup-trash.js';
import { EmptyTrashUseCase } from './empty-trash.use-case.js';
import type { ObjectStore } from './ports/object-store.js';
import type { StorageAccess } from './storage-access.js';

const ORG = '01900000-0000-7000-8000-000000000001';
const SPACE = '01900000-0000-7000-8000-000000000002';
const OBJ_A = '01900000-0000-7000-8000-00000000000a';
const OBJ_B = '01900000-0000-7000-8000-00000000000b';
const USER = { userId: '01900000-0000-7000-8000-0000000000c1' };
const PROOF = 'proof';
const v = (n: number) =>
  `01900000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`;

function setup() {
  const trace: string[] = [];
  const objects = new Map<string, BackupObject>([
    [
      OBJ_A,
      BackupObject.restore({
        id: OBJ_A,
        organizationId: ORG,
        spaceId: SPACE,
        currentVersionId: v(3),
        deletedAt: null,
      }),
    ],
    [
      OBJ_B,
      BackupObject.restore({
        id: OBJ_B,
        organizationId: ORG,
        spaceId: SPACE,
        currentVersionId: v(5),
        deletedAt: new Date('2026-11-01T00:00:00Z'),
      }),
    ],
  ]);
  // OBJ_A: v1, v2 in the trash, v3 live. OBJ_B (deleted): v4, v5 in the trash.
  const candidates = [
    { id: v(4), objectId: OBJ_B },
    { id: v(1), objectId: OBJ_A },
    { id: v(2), objectId: OBJ_A },
    { id: v(5), objectId: OBJ_B },
  ];
  const s3Of = (id: string) => `s3-${id.slice(-2)}`;
  const access = {
    require: vi.fn(async (_s: string, _a: unknown, permission: string) => {
      trace.push(`require:${permission}`);
      return { organizationId: ORG, spaceId: SPACE };
    }),
    lock: vi.fn(
      async (_s: string, _a: unknown, permission: string, mode: string) => {
        trace.push(`lock:${permission}:${mode}`);
        return { organizationId: ORG, spaceId: SPACE };
      },
    ),
  };
  const verifier = {
    verify: vi.fn(async () => {
      trace.push('verify');
    }),
  };
  const objectRepo = {
    lockForUpdate: vi.fn(async (_o: string, _s: string, id: string) => {
      trace.push(`lockObject:${id}`);
      return objects.get(id) ?? null;
    }),
  };
  let remaining = 0;
  const versionRepo = {
    trashCandidates: vi.fn(async (_o: string, _s: string, limit: number) => {
      trace.push(`candidates:${limit}`);
      return candidates.slice(0, limit);
    }),
    markPurged: vi.fn(
      async (
        _o: string,
        _s: string,
        ids: readonly string[],
      ): Promise<PurgedVersion[]> => {
        trace.push(`markPurged:${ids.join(',')}`);
        return ids.map((id) => ({
          id,
          objectId: candidates.find((c) => c.id === id)!.objectId,
          s3VersionId: s3Of(id),
          sizeBytes: 100,
        }));
      },
    ),
    trashUsage: vi.fn(async () => {
      trace.push('trashUsage');
      return { versions: remaining, bytes: remaining * 100 };
    }),
  };
  const store = {
    deleteVersions: vi.fn(
      async (items: readonly { key: string; versionId: string }[]) => {
        trace.push(`deleteVersions:${items.length}`);
        for (const { key, versionId } of items) {
          trace.push(`deleteVersion:${key.split('/').pop()}:${versionId}`);
        }
        return { failed: [] as { key: string; versionId: string }[] };
      },
    ),
  };
  const audit = {
    record: vi.fn(async (entry: { action: string }) => {
      trace.push(`audit:${entry.action}`);
    }),
  };
  const uow = {
    run: vi.fn(async <T>(work: () => Promise<T>) => {
      trace.push('run');
      const out = await work();
      trace.push('commit');
      return out;
    }),
  };
  const versionsDep = versionRepo as unknown as BackupObjectVersionRepository;
  const storeDep = store as unknown as ObjectStore;
  const trash = new BackupTrash(versionsDep, storeDep);
  return {
    trace,
    setRemaining: (n: number) => {
      remaining = n;
    },
    mocks: { access, verifier, objectRepo, versionRepo, store, audit, uow },
    useCase: new EmptyTrashUseCase(
      access as unknown as StorageAccess,
      verifier as unknown as CurrentAuthProofVerifier,
      objectRepo as unknown as BackupObjectRepository,
      versionsDep,
      trash,
      audit as unknown as AuditLog,
      uow as unknown as UnitOfWork,
    ),
  };
}

let t: ReturnType<typeof setup>;
beforeEach(() => {
  t = setup();
});

describe('EmptyTrashUseCase', () => {
  it('checks the Gestor permission, then reauthenticates, BEFORE any write', async () => {
    await t.useCase.execute(USER, SPACE, PROOF);
    expect(t.trace.slice(0, 3)).toEqual([
      'require:space.members.manage',
      'verify',
      'run',
    ]);
    expect(t.mocks.verifier.verify).toHaveBeenCalledWith(USER.userId, PROOF);
  });

  it('a wrong proof (422) writes nothing: no transaction, no purge, no S3 delete', async () => {
    t.mocks.verifier.verify.mockRejectedValueOnce(
      new DomainValidationError(
        'current-auth-proof-invalid',
        'The current password is incorrect.',
      ),
    );
    await expect(t.useCase.execute(USER, SPACE, PROOF)).rejects.toMatchObject({
      code: 'current-auth-proof-invalid',
    });
    expect(t.mocks.uow.run).not.toHaveBeenCalled();
    expect(t.mocks.versionRepo.markPurged).not.toHaveBeenCalled();
    expect(t.mocks.store.deleteVersions).not.toHaveBeenCalled();
    expect(t.mocks.audit.record).not.toHaveBeenCalled();
  });

  it('a member without the permission (403) never spends the Argon2', async () => {
    t.mocks.access.require.mockRejectedValueOnce(
      new PermissionDeniedError('forbidden', 'no'),
    );
    await expect(t.useCase.execute(USER, SPACE, PROOF)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    expect(t.mocks.verifier.verify).not.toHaveBeenCalled();
    expect(t.mocks.uow.run).not.toHaveBeenCalled();
  });

  it('locks the space FOR SHARE and the objects in id order, purges in the index, audits, and deletes in S3 only after the COMMIT', async () => {
    t.setRemaining(7);
    const out = await t.useCase.execute(USER, SPACE, PROOF);
    expect(out).toEqual({
      purgedVersions: 4,
      purgedBytes: 400,
      remainingVersions: 7,
    });
    const tx = t.trace.slice(t.trace.indexOf('run'));
    expect(tx.slice(0, 5)).toEqual([
      'run',
      'lock:space.members.manage:share',
      `candidates:${MAX_PURGE_BATCH_VERSIONS}`,
      `lockObject:${OBJ_A}`,
      `lockObject:${OBJ_B}`,
    ]);
    const commit = t.trace.indexOf('commit');
    // ONE batched S3 call (DeleteObjects, up to 1000 versions), never one call per version.
    expect(t.trace.filter((x) => x.startsWith('deleteVersions:'))).toEqual([
      'deleteVersions:4',
    ]);
    expect(t.trace.indexOf('audit:space.backup.trash_emptied')).toBeLessThan(
      commit,
    );
    const deletes = t.trace.filter((x) => x.startsWith('deleteVersion:'));
    expect(deletes.sort()).toEqual(
      [
        `deleteVersion:${OBJ_A}:s3-01`,
        `deleteVersion:${OBJ_A}:s3-02`,
        `deleteVersion:${OBJ_B}:s3-04`,
        `deleteVersion:${OBJ_B}:s3-05`,
      ].sort(),
    );
    for (const d of deletes) expect(t.trace.indexOf(d)).toBeGreaterThan(commit);
    expect(t.mocks.audit.record).toHaveBeenCalledWith({
      organizationId: ORG,
      userId: USER.userId,
      action: 'space.backup.trash_emptied',
      metadata: { spaceId: SPACE, purgedVersions: 4, purgedBytes: 400 },
    });
  });

  it('never purges the live version of a live object, even if the candidates list it', async () => {
    t.mocks.versionRepo.trashCandidates.mockResolvedValueOnce([
      { id: v(1), objectId: OBJ_A },
      { id: v(3), objectId: OBJ_A }, // the live version of OBJ_A
    ]);
    await t.useCase.execute(USER, SPACE, PROOF);
    expect(t.mocks.versionRepo.markPurged).toHaveBeenCalledWith(ORG, SPACE, [
      v(1),
    ]);
  });

  it('asks for at most MAX_PURGE_BATCH_VERSIONS (1000) candidates per call', async () => {
    expect(MAX_PURGE_BATCH_VERSIONS).toBe(1000);
    await t.useCase.execute(USER, SPACE, PROOF);
    expect(t.mocks.versionRepo.trashCandidates).toHaveBeenCalledWith(
      ORG,
      SPACE,
      1000,
    );
  });

  it('an empty trash answers zeros without an audit row or S3 call', async () => {
    t.mocks.versionRepo.trashCandidates.mockResolvedValueOnce([]);
    expect(await t.useCase.execute(USER, SPACE, PROOF)).toEqual({
      purgedVersions: 0,
      purgedBytes: 0,
      remainingVersions: 0,
    });
    expect(t.mocks.versionRepo.markPurged).not.toHaveBeenCalled();
    expect(t.mocks.audit.record).not.toHaveBeenCalled();
    expect(t.mocks.store.deleteVersions).not.toHaveBeenCalled();
  });

  it('an S3 delete that fails after the COMMIT does not fail the request (the journal mark lets the sweep finish)', async () => {
    t.mocks.store.deleteVersions.mockRejectedValueOnce(new Error('S3 down'));
    const out = await t.useCase.execute(USER, SPACE, PROOF);
    expect(out.purgedVersions).toBe(4);
    expect(t.mocks.store.deleteVersions).toHaveBeenCalledTimes(1);
  });

  it('versions S3 refused to delete (per-key errors) do not fail the request either', async () => {
    t.mocks.store.deleteVersions.mockResolvedValueOnce({
      failed: [{ key: `x/${OBJ_A}`, versionId: 's3-01' }],
    });
    expect((await t.useCase.execute(USER, SPACE, PROOF)).purgedVersions).toBe(
      4,
    );
  });

  it('a call that purges nothing answers remainingVersions 0, so the app loop always stops', async () => {
    t.mocks.versionRepo.trashCandidates.mockResolvedValueOnce([
      { id: v(3), objectId: OBJ_A }, // only the live version: filtered out
    ]);
    t.setRemaining(3); // what the count would say (e.g. versions taken by a concurrent purge)
    expect(await t.useCase.execute(USER, SPACE, PROOF)).toEqual({
      purgedVersions: 0,
      purgedBytes: 0,
      remainingVersions: 0,
    });
    expect(t.mocks.store.deleteVersions).not.toHaveBeenCalled();
  });

  it('a lock wait past the storage lock_timeout is 409 storage-busy', async () => {
    t.mocks.objectRepo.lockForUpdate.mockRejectedValueOnce(
      new QueryFailedError(
        'SELECT',
        [],
        Object.assign(new Error('lock'), {
          code: '55P03',
        }),
      ),
    );
    const error = await t.useCase.execute(USER, SPACE, PROOF).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.code).toBe('storage-busy');
    expect(t.mocks.store.deleteVersions).not.toHaveBeenCalled();
  });
});
