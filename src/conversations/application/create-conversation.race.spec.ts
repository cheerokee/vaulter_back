import type { ConversationCloudReserve } from './conversation-cloud-reserve.js';
import type { SpaceCloud } from '../../spaces/application/space-cloud.js';
import type { HubAccess } from '../../hubs/application/hub-access.js';
import type { HubDirectory } from '../../hubs/application/hub-directory.js';
import { ConflictError } from '../../shared/domain/errors.js';
import { newId } from '../../shared/domain/id.js';
import type { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { SpaceAccess } from '../../spaces/application/space-access.js';
import type { SpaceStorage } from '../../spaces/application/space-storage.js';
import type { SpaceStorageUsage } from '../../spaces/application/space-storage-usage.js';
import { conversationIdConflict } from '../domain/conversation-errors.js';
import type { ConversationKeyGrantRepository } from '../domain/conversation-key-grant.repository.js';
import type { ConversationParticipantRepository } from '../domain/conversation-participant.repository.js';
import type { ConversationRepository } from '../domain/conversation.repository.js';
import { Conversation } from '../domain/conversation.js';
import type { ConversationAccess } from './conversation-access.js';
import type { ConversationExecutors } from './conversation-executors.js';
import type { ConversationViews } from './conversation-views.js';
import { CreateConversationUseCase } from './create-conversation.use-case.js';
import { HubCreateConversationUseCase } from './hub-create-conversation.use-case.js';

const as = <T>(x: unknown) => x as T;
const ORG = newId();
const SPACE = newId();
const OTHER_SPACE = newId();
const ANA = newId();
const HUB = newId();
const ID = newId();

const blob = (n = 60) => {
  const b = Buffer.alloc(n, 0xab);
  b[0] = 0x01;
  return b.toString('base64url');
};
const wrapped = () => {
  const b = Buffer.alloc(81, 0xcd);
  b[0] = 0x01;
  return b.toString('base64url');
};
const stored = (spaceId = SPACE) =>
  Conversation.create({
    id: ID,
    organizationId: ORG,
    spaceId,
    createdByUserId: ANA,
    ownerUserId: ANA,
    executorHubId: null,
    state: 'na_fila',
    encryptedHeader: blob(),
    now: new Date(),
  });

// Idempotent create under a race: both requests read "no such id", one inserts first, the other hits the PK
// conflict inside its own savepoint and must answer like a retry (200, the same conversation) or a real conflict.
describe('create conversation: the same id racing', () => {
  const conversations = {
    findById: vi.fn(),
    create: vi.fn(),
  };
  const views = {
    of: vi.fn(async (_s: unknown, c: Conversation) => ({ id: c.id })),
    reload: vi.fn(async () => ({ id: ID })),
  };
  const grants = { put: vi.fn() };
  const uow = {
    run: vi.fn(<T>(work: () => Promise<T>) => work()),
    setContext: vi.fn(async () => undefined),
  };
  const spaceStorage = { lockQuota: vi.fn(async () => 1_000_000) };
  const usage = { usedBytes: vi.fn(async () => 0) };
  const spaces = {
    requireSpacePermission: vi.fn(async () => ({
      space: { organizationId: ORG },
    })),
    lockAsMember: vi.fn(async () => ({ space: { organizationId: ORG } })),
    isSpaceMember: vi.fn(async () => true),
  };
  const executors = { lockEligible: vi.fn(async () => ANA) };

  const user = new CreateConversationUseCase(
    as<SpaceAccess>(spaces),
    as<ConversationAccess>({}),
    as<ConversationExecutors>(executors),
    as<ConversationRepository>(conversations),
    as<ConversationKeyGrantRepository>(grants),
    as<ConversationViews>(views),
    as<UnitOfWork>(uow),
    as<SpaceStorage>(spaceStorage),
    as<SpaceStorageUsage>(usage),
    as<SpaceCloud>({ modeOf: vi.fn(async () => 'encrypted_backup') }),
    as<ConversationCloudReserve>({}),
  );
  const hub = new HubCreateConversationUseCase(
    as<HubDirectory>({
      installedSpaceOrganization: vi.fn(async () => ORG),
    }),
    as<HubAccess>({ hasAccess: vi.fn(async () => true) }),
    as<SpaceAccess>(spaces),
    as<ConversationExecutors>(executors),
    as<ConversationRepository>(conversations),
    as<ConversationParticipantRepository>({ add: vi.fn() }),
    as<ConversationKeyGrantRepository>(grants),
    as<ConversationViews>(views),
    as<UnitOfWork>(uow),
    as<SpaceStorage>(spaceStorage),
    as<SpaceStorageUsage>(usage),
    as<SpaceCloud>({ modeOf: vi.fn(async () => 'encrypted_backup') }),
    as<ConversationCloudReserve>({}),
  );
  const userInput = {
    id: ID,
    encryptedHeader: blob(),
    wrappedKey: wrapped(),
  };
  const hubInput = {
    id: ID,
    spaceId: SPACE,
    ownerUserId: ANA,
    encryptedHeader: blob(),
    grants: [{ userId: ANA, wrappedKey: wrapped() }],
    hubWrappedKey: wrapped(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Drop queued `...Once` values a failing test may have left behind.
    conversations.findById.mockReset();
    conversations.create.mockReset();
    conversations.create.mockRejectedValue(conversationIdConflict());
  });

  it('person: the racing twin answers 200 with the same conversation, never 409', async () => {
    conversations.findById
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(stored());
    await expect(
      user.execute({ userId: ANA, sessionId: newId() }, SPACE, userInput),
    ).resolves.toEqual({ view: { id: ID }, created: false });
    expect(grants.put).not.toHaveBeenCalled();
  });

  it('person: a different conversation behind the same id is still 409', async () => {
    conversations.findById
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(stored(OTHER_SPACE));
    await expect(
      user.execute({ userId: ANA, sessionId: newId() }, SPACE, userInput),
    ).rejects.toMatchObject({
      constructor: ConflictError,
      code: 'conversation-id-conflict',
    });
  });

  it('person: an id the scope cannot see (another conversation) stays 409', async () => {
    conversations.findById.mockResolvedValue(null);
    await expect(
      user.execute({ userId: ANA, sessionId: newId() }, SPACE, userInput),
    ).rejects.toMatchObject({ code: 'conversation-id-conflict' });
  });

  it('hub: the racing twin answers 200 with the same conversation', async () => {
    conversations.findById
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(stored());
    await expect(hub.execute({ hubId: HUB }, hubInput)).resolves.toEqual({
      view: { id: ID },
      created: false,
    });
    expect(grants.put).not.toHaveBeenCalled();
  });

  it('hub: another space behind the same id is 409', async () => {
    conversations.findById
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(stored(OTHER_SPACE));
    await expect(hub.execute({ hubId: HUB }, hubInput)).rejects.toMatchObject({
      code: 'conversation-id-conflict',
    });
  });
});
