import type { AuditLog } from '../../organizations/application/audit-log.js';
import type { OrganizationAccess } from '../../organizations/application/organization-access.js';
import type { JobQueue } from '../../shared/application/job-queue.js';
import type { SpaceKeyRotatedHooks } from '../../shared/application/space-key-rotated-hooks.js';
import type { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { SpaceCloud } from '../../spaces/application/space-cloud.js';
import { Space } from '../../spaces/domain/space.js';
import type {
  CloudTermAcceptanceRepository,
  CloudTermRepository,
  ServerKeyGrantRepository,
  SpaceActivationRepository,
} from '../domain/cloud.repositories.js';
import { SpaceActivation } from '../domain/space-activation.js';
import { sealedCopyInvalid } from '../domain/sealed-copy.js';
import { CloudKeyRotatedHook } from './cloud-key-rotated.hook.js';
import type { CloudSpaceAccess } from './cloud-space-access.js';
import { CloudSpaceJobs } from './cloud-space-jobs.js';
import { AcceptCloudTermsUseCase } from './cloud-terms.use-cases.js';
import type { ServerKeyring } from './ports/server-keyring.js';
import {
  ActivateSpaceCloudUseCase,
  AuthorizeSpaceCloudUseCase,
  DeactivateSpaceCloudUseCase,
} from './space-cloud.use-cases.js';

const ORG = '019a0000-0000-7000-8000-00000000000a';
const SPACE = '019a0000-0000-7000-8000-0000000000b1';
const ADMIN = '019a0000-0000-7000-8000-0000000000c1';
const MANAGER = '019a0000-0000-7000-8000-0000000000c2';
const HASH = 'f'.repeat(64);
const copy = (n: number) =>
  Buffer.concat([Buffer.from([0x01]), Buffer.alloc(80, n)]).toString(
    'base64url',
  );
const TERM = { version: 1, hash: HASH, text: 't', publishedAt: new Date() };
const ACCEPTED = {
  organizationId: ORG,
  termVersion: 1,
  termHash: HASH,
  acceptedByUserId: ADMIN,
  acceptedAt: new Date(),
};

function space(
  over: { cloud?: boolean; allowOnlineLlm?: boolean } = {},
): Space {
  return Space.restore(
    {
      organizationId: ORG,
      name: 'Manuais',
      currentKeyVersion: 2,
      keyRotationRequired: false,
      storageQuotaBytes: 10_737_418_240,
      allowOnlineLlm: over.allowOnlineLlm ?? true,
      ...(over.cloud
        ? { cloudMode: 'active_cloud' as const, cloudActivatedAt: new Date() }
        : {}),
    },
    SPACE,
  );
}

function setup() {
  const trace: string[] = [];
  const t =
    <A extends unknown[], R>(name: string, impl: (...a: A) => R) =>
    (...a: A) => {
      trace.push(name);
      return impl(...a);
    };
  const opened: Uint8Array[] = [];
  const access = {
    lockAsDecider: vi.fn(t('access.lockAsDecider', async () => space())),
    lockAsManager: vi.fn(t('access.lockAsManager', async () => space())),
    lockAsManagerOrDecider: vi.fn(
      t('access.lockAsManagerOrDecider', async () => space({ cloud: true })),
    ),
    memberCount: vi.fn(async () => 2),
  };
  const terms = { current: vi.fn(async () => TERM) };
  const acceptances = {
    latest: vi.fn(async (): Promise<typeof ACCEPTED | null> => ACCEPTED),
    acceptOnce: vi.fn(async (a: typeof ACCEPTED) => ({
      acceptance: a,
      created: true,
    })),
  };
  const activations = {
    findLive: vi.fn(),
    lockLive: vi.fn(
      t(
        'activations.lockLive',
        async (): Promise<SpaceActivation | null> => null,
      ),
    ),
    insert: vi.fn(t('activations.insert', async () => undefined)),
    save: vi.fn(t('activations.save', async () => undefined)),
    end: vi.fn(t('activations.end', async () => undefined)),
  };
  const grants = {
    insert: vi.fn(t('grants.insert', async () => undefined)),
    deleteForSpace: vi.fn(t('grants.deleteForSpace', async () => 2)),
  };
  const spaceCloud = {
    keyVersions: vi.fn(async () => [
      { id: 'k1', version: 1 },
      { id: 'k2', version: 2 },
    ]),
    markActive: vi.fn(t('spaceCloud.markActive', async () => undefined)),
    markEncryptedBackup: vi.fn(
      t('spaceCloud.markEncryptedBackup', async () => undefined),
    ),
  };
  const keyring = {
    publicKey: vi.fn(),
    openSealed: vi.fn(async (c: string) => {
      if (c === 'x'.repeat(108)) throw sealedCopyInvalid();
      const key = new Uint8Array(32).fill(7);
      opened.push(key);
      return key;
    }),
  };
  const jobQueue = {
    cancelQueued: vi.fn(t('jobs.cancelQueued', async () => 1)),
  };
  const jobs = new CloudSpaceJobs(jobQueue as unknown as JobQueue);
  const audit = { record: vi.fn(async () => undefined) };
  const uow = { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
  const orgAccess = {
    requirePermission: vi.fn(async () => undefined),
  };
  /** The live cycle returned by the next `lockLive` (keeps the trace). */
  const liveOnce = (a: SpaceActivation) =>
    activations.lockLive.mockImplementationOnce(async () => {
      trace.push('activations.lockLive');
      return a;
    });
  return {
    liveOnce,
    trace,
    opened,
    access,
    terms,
    acceptances,
    activations,
    grants,
    spaceCloud,
    keyring,
    jobQueue,
    jobs,
    audit,
    uow,
    orgAccess,
    deps: {
      access: access as unknown as CloudSpaceAccess,
      terms: terms as unknown as CloudTermRepository,
      acceptances: acceptances as unknown as CloudTermAcceptanceRepository,
      activations: activations as unknown as SpaceActivationRepository,
      grants: grants as unknown as ServerKeyGrantRepository,
      spaceCloud: spaceCloud as unknown as SpaceCloud,
      keyring: keyring as unknown as ServerKeyring,
      audit: audit as unknown as AuditLog,
      uow: uow as unknown as UnitOfWork,
      orgAccess: orgAccess as unknown as OrganizationAccess,
    },
  };
}

const actor = (userId: string) => ({ userId, sessionId: 's', hubId: null });
const authorizedActivation = () =>
  SpaceActivation.authorize({
    organizationId: ORG,
    spaceId: SPACE,
    termVersion: 1,
    byUserId: ADMIN,
    at: new Date(),
  });

describe('AcceptCloudTermsUseCase', () => {
  it('records once per version and audits only the first time', async () => {
    const k = setup();
    const uc = new AcceptCloudTermsUseCase(
      k.deps.orgAccess,
      k.deps.terms,
      k.deps.acceptances,
      k.deps.audit,
      k.deps.uow,
    );
    await uc.execute(actor(ADMIN), ORG, {
      version: 1,
      hash: HASH,
      ip: '1.2.3.4',
    });
    expect(k.orgAccess.requirePermission).toHaveBeenCalledWith(
      ORG,
      ADMIN,
      'org.members.manage',
    );
    expect(k.acceptances.acceptOnce).toHaveBeenCalledWith(
      expect.objectContaining({ termVersion: 1, ip: '1.2.3.4' }),
    );
    expect(k.audit.record).toHaveBeenCalledWith({
      organizationId: ORG,
      userId: ADMIN,
      action: 'organization.cloud_terms.accepted',
      metadata: { termVersion: 1, termHash: HASH },
    });
    k.acceptances.acceptOnce.mockResolvedValueOnce({
      acceptance: ACCEPTED,
      created: false,
    });
    k.audit.record.mockClear();
    await uc.execute(actor(ADMIN), ORG, { version: 1, hash: HASH, ip: null });
    expect(k.audit.record).not.toHaveBeenCalled();
  });

  it('a stale screen (other hash) is 422 cloud-terms-outdated, nothing recorded', async () => {
    const k = setup();
    const uc = new AcceptCloudTermsUseCase(
      k.deps.orgAccess,
      k.deps.terms,
      k.deps.acceptances,
      k.deps.audit,
      k.deps.uow,
    );
    await expect(
      uc.execute(actor(ADMIN), ORG, {
        version: 1,
        hash: 'e'.repeat(64),
        ip: null,
      }),
    ).rejects.toMatchObject({ code: 'cloud-terms-outdated' });
    expect(k.acceptances.acceptOnce).not.toHaveBeenCalled();
  });
});

describe('AuthorizeSpaceCloudUseCase', () => {
  const uc = (k: ReturnType<typeof setup>) =>
    new AuthorizeSpaceCloudUseCase(
      k.deps.access,
      k.deps.terms,
      k.deps.acceptances,
      k.deps.activations,
      k.deps.audit,
      k.deps.uow,
    );

  it('locks the space as decider, then the cycle; records the authorization with the term version', async () => {
    const k = setup();
    await expect(uc(k).execute(actor(ADMIN), SPACE)).resolves.toMatchObject({
      state: 'authorized',
      termVersion: 1,
      authorizedByUserId: ADMIN,
    });
    expect(k.trace).toEqual([
      'access.lockAsDecider',
      'activations.lockLive',
      'activations.insert',
    ]);
    expect(k.audit.record).toHaveBeenCalledWith({
      organizationId: ORG,
      userId: ADMIN,
      action: 'space.cloud.authorized',
      metadata: { spaceId: SPACE, termVersion: 1 },
    });
  });

  it('already authorized or active: returns it, writes nothing', async () => {
    const k = setup();
    k.liveOnce(authorizedActivation());
    await expect(uc(k).execute(actor(ADMIN), SPACE)).resolves.toMatchObject({
      state: 'authorized',
    });
    expect(k.activations.insert).not.toHaveBeenCalled();
    expect(k.audit.record).not.toHaveBeenCalled();
  });

  it.each([
    ['term not accepted', 'cloud-terms-not-accepted'],
    ['orphan space', 'space-orphaned'],
    ['online LLM not allowed', 'online-llm-not-allowed'],
  ])('%s: 422, nothing written', async (what, code) => {
    const k = setup();
    if (what === 'term not accepted')
      k.acceptances.latest.mockResolvedValue(null);
    if (what === 'orphan space') k.access.memberCount.mockResolvedValue(0);
    if (what === 'online LLM not allowed') {
      k.access.lockAsDecider.mockResolvedValue(
        space({ allowOnlineLlm: false }),
      );
    }
    await expect(uc(k).execute(actor(ADMIN), SPACE)).rejects.toMatchObject({
      code,
    });
    expect(k.activations.insert).not.toHaveBeenCalled();
    expect(k.audit.record).not.toHaveBeenCalled();
  });
});

describe('ActivateSpaceCloudUseCase', () => {
  const uc = (k: ReturnType<typeof setup>) =>
    new ActivateSpaceCloudUseCase(
      k.deps.access,
      k.deps.spaceCloud,
      k.deps.terms,
      k.deps.acceptances,
      k.deps.activations,
      k.deps.grants,
      k.deps.keyring,
      k.deps.audit,
      k.deps.uow,
    );
  const input = {
    serverGrants: [
      { version: 1, wrappedKey: copy(1) },
      { version: 2, wrappedKey: copy(2) },
    ],
  };

  it('the manager switches on: every copy opened (and wiped), stored, space marked active, audited without copies', async () => {
    const k = setup();
    k.liveOnce(authorizedActivation());
    await expect(
      uc(k).execute(actor(MANAGER), SPACE, input),
    ).resolves.toMatchObject({ state: 'active', activatedByUserId: MANAGER });
    expect(k.keyring.openSealed).toHaveBeenCalledTimes(2);
    for (const key of k.opened) expect(key.every((b) => b === 0)).toBe(true);
    expect(k.grants.insert).toHaveBeenCalledWith({
      organizationId: ORG,
      spaceId: SPACE,
      spaceKeyId: 'k2',
      keyVersion: 2,
      wrappedKey: copy(2),
    });
    expect(k.trace.slice(0, 2)).toEqual([
      'access.lockAsManager',
      'activations.lockLive',
    ]);
    expect(k.spaceCloud.markActive).toHaveBeenCalledWith(
      ORG,
      SPACE,
      expect.any(Date),
    );
    expect(JSON.stringify(k.audit.record.mock.calls)).not.toContain(copy(1));
    expect(k.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'space.cloud.activated',
        metadata: { spaceId: SPACE, keyVersions: 2 },
      }),
    );
  });

  it('not authorized: 422 cloud-not-authorized; already active: 409', async () => {
    const k = setup();
    await expect(
      uc(k).execute(actor(MANAGER), SPACE, input),
    ).rejects.toMatchObject({ code: 'cloud-not-authorized' });
    const active = authorizedActivation();
    active.activate(MANAGER, new Date());
    k.liveOnce(active);
    await expect(
      uc(k).execute(actor(MANAGER), SPACE, input),
    ).rejects.toMatchObject({ code: 'cloud-already-active' });
    expect(k.spaceCloud.markActive).not.toHaveBeenCalled();
  });

  it('a missing version: 409 key-versions-mismatch, nothing opened or stored', async () => {
    const k = setup();
    k.liveOnce(authorizedActivation());
    await expect(
      uc(k).execute(actor(MANAGER), SPACE, {
        serverGrants: [input.serverGrants[0]!],
      }),
    ).rejects.toMatchObject({
      code: 'key-versions-mismatch',
      details: expect.objectContaining({ missingVersions: [2] }),
    });
    expect(k.keyring.openSealed).not.toHaveBeenCalled();
    expect(k.grants.insert).not.toHaveBeenCalled();
  });

  it('a copy not sealed to the server key: 422 server-copy-invalid, space not marked', async () => {
    const k = setup();
    k.liveOnce(authorizedActivation());
    await expect(
      uc(k).execute(actor(MANAGER), SPACE, {
        serverGrants: [
          { version: 1, wrappedKey: copy(1) },
          { version: 2, wrappedKey: 'x'.repeat(108) },
        ],
      }),
    ).rejects.toMatchObject({ code: 'server-copy-invalid' });
    expect(k.spaceCloud.markActive).not.toHaveBeenCalled();
  });

  it('a malformed copy: 422 before any lock', async () => {
    const k = setup();
    await expect(
      uc(k).execute(actor(MANAGER), SPACE, {
        serverGrants: [{ version: 1, wrappedKey: 'short' }],
      }),
    ).rejects.toMatchObject({ code: 'server-copy-invalid' });
    expect(k.access.lockAsManager).not.toHaveBeenCalled();
  });

  it('a new term published after the authorization must be accepted before switching on', async () => {
    const k = setup();
    k.liveOnce(authorizedActivation());
    k.terms.current.mockResolvedValue({ ...TERM, version: 2 });
    await expect(
      uc(k).execute(actor(MANAGER), SPACE, input),
    ).rejects.toMatchObject({ code: 'cloud-terms-not-accepted' });
  });
});

describe('DeactivateSpaceCloudUseCase', () => {
  const uc = (k: ReturnType<typeof setup>) =>
    new DeactivateSpaceCloudUseCase(
      k.deps.access,
      k.deps.spaceCloud,
      k.deps.activations,
      k.deps.grants,
      k.jobs,
      k.deps.audit,
      k.deps.uow,
    );

  it('deletes the server copies, cancels waiting jobs, ends the cycle and goes back to encrypted_backup', async () => {
    const k = setup();
    k.jobs.register('cloud.test-index');
    const active = authorizedActivation();
    active.activate(MANAGER, new Date());
    k.liveOnce(active);
    await uc(k).execute(actor(ADMIN), SPACE);
    expect(k.trace).toEqual([
      'access.lockAsManagerOrDecider',
      'activations.lockLive',
      'grants.deleteForSpace',
      'jobs.cancelQueued',
      'activations.end',
      'spaceCloud.markEncryptedBackup',
    ]);
    expect(k.jobQueue.cancelQueued).toHaveBeenCalledWith('cloud.test-index', {
      spaceId: SPACE,
    });
    expect(k.audit.record).toHaveBeenCalledWith({
      organizationId: ORG,
      userId: ADMIN,
      action: 'space.cloud.deactivated',
      metadata: {
        spaceId: SPACE,
        previousState: 'active',
        serverCopiesDeleted: 2,
        jobsCancelled: 1,
      },
    });
  });

  it('nothing on: idempotent, writes and audits nothing', async () => {
    const k = setup();
    k.access.lockAsManagerOrDecider.mockResolvedValueOnce(space());
    await uc(k).execute(actor(ADMIN), SPACE);
    expect(k.grants.deleteForSpace).not.toHaveBeenCalled();
    expect(k.audit.record).not.toHaveBeenCalled();
  });

  it('only authorized: cancels the authorization (the space was never marked active)', async () => {
    const k = setup();
    k.access.lockAsManagerOrDecider.mockResolvedValueOnce(space());
    k.liveOnce(authorizedActivation());
    await uc(k).execute(actor(ADMIN), SPACE);
    expect(k.activations.end).toHaveBeenCalled();
    expect(k.spaceCloud.markEncryptedBackup).not.toHaveBeenCalled();
  });
});

describe('CloudKeyRotatedHook', () => {
  it('stores the server copy of a rotated version after opening it; ignores rotations without one', async () => {
    const k = setup();
    const registry = { register: vi.fn(), unregister: vi.fn() };
    const hook = new CloudKeyRotatedHook(
      registry as unknown as SpaceKeyRotatedHooks,
      k.deps.keyring,
      k.deps.grants,
    );
    const ctx = {
      organizationId: ORG,
      spaceId: SPACE,
      spaceKeyId: 'k3',
      version: 3,
      serverWrappedKey: null,
      actorUserId: MANAGER,
    };
    await hook.onRotated(ctx);
    expect(k.grants.insert).not.toHaveBeenCalled();
    await hook.onRotated({ ...ctx, serverWrappedKey: copy(3) });
    expect(k.opened[0]!.every((b) => b === 0)).toBe(true);
    expect(k.grants.insert).toHaveBeenCalledWith({
      organizationId: ORG,
      spaceId: SPACE,
      spaceKeyId: 'k3',
      keyVersion: 3,
      wrappedKey: copy(3),
    });
    await expect(
      hook.onRotated({ ...ctx, serverWrappedKey: 'x'.repeat(108) }),
    ).rejects.toMatchObject({ code: 'server-copy-invalid' });
  });
});

describe('CloudSpaceJobs', () => {
  it('cancels the waiting jobs of the space in every registered queue', async () => {
    const k = setup();
    expect(await k.jobs.cancelForSpace(SPACE)).toBe(0);
    k.jobs.register('cloud.b');
    k.jobs.register('cloud.a');
    expect(await k.jobs.cancelForSpace(SPACE)).toBe(2);
    expect(k.jobQueue.cancelQueued.mock.calls).toEqual([
      ['cloud.a', { spaceId: SPACE }],
      ['cloud.b', { spaceId: SPACE }],
    ]);
    expect(() => k.jobs.register('Bad Name')).toThrow();
  });
});
