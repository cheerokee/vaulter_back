import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';
import { newId } from '../../shared/domain/id.js';
import type { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { SpaceStorage } from '../../spaces/application/space-storage.js';
import type { SpaceStorageUsage } from '../../spaces/application/space-storage-usage.js';
import type { ConversationScope } from '../domain/conversation-actor.js';
import type { ConversationRepository } from '../domain/conversation.repository.js';
import { Conversation } from '../domain/conversation.js';
import type { ConversationAccess } from './conversation-access.js';
import type { ConversationViews } from './conversation-views.js';
import { ReplaceConversationHeaderUseCase } from './replace-conversation-header.use-case.js';

const as = <T>(x: unknown) => x as T;
const ORG = newId();
const SPACE = newId();
const HUB = newId();
const OTHER_HUB = newId();
const ANA = newId();
const BIA = newId();
const CONV = newId();

const blob = (n = 60, fill = 0xab) => {
  const b = Buffer.alloc(n, fill);
  b[0] = 0x01;
  return b.toString('base64url');
};

const conversation = (over: { keyRotationRequired?: boolean } = {}) =>
  Conversation.restore(
    {
      organizationId: ORG,
      spaceId: SPACE,
      createdByUserId: ANA,
      ownerUserId: ANA,
      executorHubId: HUB,
      state: 'na_fila',
      lastMessageAt: null,
      currentKeyVersion: 2,
      keyRotationRequired: over.keyRotationRequired ?? false,
      encryptedHeader: blob(),
      headerKeyVersion: 1,
      movedFromConversationId: null,
      cloudReserve: false,
      cloudReserveDeclined: false,
      participantUserIds: [ANA, BIA].sort(),
      createdAt: new Date(),
      deletedAt: null,
    },
    CONV,
  );

describe('ReplaceConversationHeaderUseCase', () => {
  const trace: string[] = [];
  let current: Conversation;
  let used: number;
  const userScope = (userId: string): ConversationScope => ({
    organizationId: ORG,
    actor: { kind: 'user', userId },
  });
  const hubScope = (hubId: string): ConversationScope => ({
    organizationId: ORG,
    actor: { kind: 'hub', hubId },
  });
  const access = {
    userScope: vi.fn(async (_space: string, userId: string) => {
      trace.push('userScope');
      return userScope(userId);
    }),
    findForHub: vi.fn(async (hubId: string) => {
      trace.push('findForHub');
      return { scope: hubScope(hubId), conversation: current };
    }),
    lock: vi.fn(async () => {
      trace.push('lockConversation');
      return current;
    }),
  };
  const spaceStorage = {
    lockQuota: vi.fn(async () => {
      trace.push('lockSpace');
      return 1000;
    }),
  };
  const usage = {
    usedBytes: vi.fn(async () => {
      trace.push('usedBytes');
      return used;
    }),
  };
  const conversations = {
    save: vi.fn(async () => {
      trace.push('save');
    }),
  };
  const views = {
    reload: vi.fn(async () => ({ id: CONV })),
  };
  const uow = {
    run: vi.fn(<T>(work: () => Promise<T>) => work()),
    setContext: vi.fn(async () => undefined),
  };
  const useCase = new ReplaceConversationHeaderUseCase(
    as<ConversationAccess>(access),
    as<SpaceStorage>(spaceStorage),
    as<SpaceStorageUsage>(usage),
    as<ConversationRepository>(conversations),
    as<ConversationViews>(views),
    as<UnitOfWork>(uow),
  );
  const ana = { userId: ANA, sessionId: newId() };

  beforeEach(() => {
    trace.length = 0;
    vi.clearAllMocks();
    current = conversation();
    used = 0;
  });

  it('the owner: space FOR SHARE -> conversation -> save -> usage checked AFTER writing', async () => {
    const header = blob(120);
    await useCase.byUser(ana, SPACE, CONV, {
      keyVersion: 2,
      encryptedHeader: header,
    });
    expect(trace).toEqual([
      'userScope',
      'lockSpace',
      'lockConversation',
      'save',
      'usedBytes',
    ]);
    expect(current.encryptedHeader).toBe(header);
    expect(current.headerKeyVersion).toBe(2);
  });

  it('another participant: 403 not-conversation-owner, nothing written', async () => {
    await expect(
      useCase.byUser({ userId: BIA, sessionId: newId() }, SPACE, CONV, {
        keyVersion: 2,
        encryptedHeader: blob(),
      }),
    ).rejects.toMatchObject({
      constructor: PermissionDeniedError,
      code: 'not-conversation-owner',
    });
    expect(conversations.save).not.toHaveBeenCalled();
  });

  it('a stale version or a pending rotation: 409, nothing written', async () => {
    await expect(
      useCase.byUser(ana, SPACE, CONV, {
        keyVersion: 1,
        encryptedHeader: blob(),
      }),
    ).rejects.toMatchObject({
      constructor: ConflictError,
      code: 'conversation-key-version-stale',
    });
    current = conversation({ keyRotationRequired: true });
    await expect(
      useCase.byUser(ana, SPACE, CONV, {
        keyVersion: 2,
        encryptedHeader: blob(),
      }),
    ).rejects.toMatchObject({
      constructor: ConflictError,
      code: 'conversation-key-rotation-required',
    });
    expect(conversations.save).not.toHaveBeenCalled();
  });

  it('a full space: 422 space-storage-full after the write (the unit of work rolls it back)', async () => {
    used = 1001;
    await expect(
      useCase.byUser(ana, SPACE, CONV, {
        keyVersion: 2,
        encryptedHeader: blob(),
      }),
    ).rejects.toMatchObject({
      constructor: DomainValidationError,
      code: 'space-storage-full',
      details: { missingBytes: 1 },
    });
  });

  it('the executor hub replaces it; a hub that is not the executor gets 404', async () => {
    await useCase.byHub({ hubId: HUB }, CONV, {
      keyVersion: 2,
      encryptedHeader: blob(80),
    });
    expect(trace).toEqual([
      'findForHub',
      'lockSpace',
      'lockConversation',
      'save',
      'usedBytes',
    ]);
    await expect(
      useCase.byHub({ hubId: OTHER_HUB }, CONV, {
        keyVersion: 2,
        encryptedHeader: blob(),
      }),
    ).rejects.toMatchObject({
      constructor: NotFoundError,
      code: 'conversation-not-found',
    });
  });
});
