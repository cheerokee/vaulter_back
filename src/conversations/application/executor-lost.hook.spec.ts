import type { ConversationCloudReserve } from './conversation-cloud-reserve.js';
import type { AuditLog } from '../../organizations/application/audit-log.js';
import type {
  HubExecutorLostContext,
  HubExecutorLostHooks,
} from '../../shared/application/hub-executor-lost-hooks.js';
import { ConflictError } from '../../shared/domain/errors.js';
import { newId } from '../../shared/domain/id.js';
import type { ConversationScope } from '../domain/conversation-actor.js';
import type { ConversationMessageRepository } from '../domain/conversation-message.repository.js';
import type { ConversationKeyGrantRepository } from '../domain/conversation-key-grant.repository.js';
import type { ConversationRepository } from '../domain/conversation.repository.js';
import { Conversation } from '../domain/conversation.js';
import { ConversationsExecutorLostHook } from './executor-lost.hook.js';

const as = <T>(x: unknown) => x as T;
const ORG = newId();
const HUB = newId();
const A = newId();
const B = newId();
const ID = newId();

const blob = () => {
  const b = Buffer.alloc(60, 0xab);
  b[0] = 0x01;
  return b.toString('base64url');
};

const conv = (owner: string, executorHubId: string | null = HUB) =>
  Conversation.restore(
    {
      organizationId: ORG,
      spaceId: newId(),
      createdByUserId: A,
      ownerUserId: owner,
      executorHubId,
      state: 'na_fila',
      lastMessageAt: null,
      currentKeyVersion: 1,
      keyRotationRequired: false,
      encryptedHeader: blob(),
      headerKeyVersion: 1,
      movedFromConversationId: null,
      cloudReserve: false,
      cloudReserveDeclined: false,
      participantUserIds: [A, B].sort(),
      createdAt: new Date(),
      deletedAt: null,
    },
    ID,
  );

const ctx: HubExecutorLostContext = {
  hubId: HUB,
  organizationId: ORG,
  spaceId: null,
  reason: 'hub_deregistered',
  actorId: A,
  now: new Date(),
};

describe('ConversationsExecutorLostHook', () => {
  const conversations = {
    idsWithExecutor: vi.fn(),
    findById: vi.fn(),
    lockById: vi.fn(),
    save: vi.fn(),
  };
  const grants = { removeFor: vi.fn() };
  const audit = { record: vi.fn() };
  const messages = { requeueAckedBy: vi.fn() };
  const hook = new ConversationsExecutorLostHook(
    as<HubExecutorLostHooks>({ register: vi.fn(), unregister: vi.fn() }),
    as<ConversationRepository>(conversations),
    as<ConversationKeyGrantRepository>(grants),
    as<AuditLog>(audit),
    as<ConversationMessageRepository>(messages),
    as<ConversationCloudReserve>({ requeued: vi.fn() }),
  );
  const userOf = (s: ConversationScope) =>
    s.actor.kind === 'user'
      ? s.actor.userId
      : s.actor.kind === 'hub'
        ? `hub:${s.actor.hubId}`
        : `cloud:${s.actor.spaceId}`;

  beforeEach(() => {
    vi.resetAllMocks();
    conversations.idsWithExecutor.mockResolvedValue([ID]);
  });

  it('writes in the OWNER scope (never the hub), and re-reads when the owner changed before the lock', async () => {
    // 1st read: owner A; under the lock the owner is already B (succession) -> read again -> owner B.
    conversations.findById
      .mockResolvedValueOnce(conv(A))
      .mockResolvedValueOnce(conv(B));
    conversations.lockById
      .mockResolvedValueOnce(conv(B))
      .mockResolvedValueOnce(conv(B));
    await hook.onExecutorLost(ctx);
    expect(conversations.findById.mock.calls.map((c) => userOf(c[0]))).toEqual([
      `hub:${HUB}`,
      `hub:${HUB}`,
    ]);
    expect(conversations.lockById.mock.calls.map((c) => userOf(c[0]))).toEqual([
      A,
      B,
    ]);
    const [scope, saved] = conversations.save.mock.calls[0]! as [
      ConversationScope,
      Conversation,
    ];
    expect(userOf(scope)).toBe(B);
    expect(saved.executorHubId).toBeNull();
    expect(saved.keyRotationRequired).toBe(true);
    expect(grants.removeFor).toHaveBeenCalledWith(expect.anything(), ID, {
      kind: 'hub',
      hubId: HUB,
    });
    // In the owner's scope too: what the hub acknowledged and never answered goes back to pending.
    expect(messages.requeueAckedBy).toHaveBeenCalledTimes(1);
    const [requeueScope, requeueId, requeueHub] = messages.requeueAckedBy.mock
      .calls[0]! as [ConversationScope, string, unknown];
    expect([userOf(requeueScope), requeueId, requeueHub]).toEqual([
      B,
      ID,
      { kind: 'hub', hubId: HUB },
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'conversation.executor_lost' }),
    );
  });

  it('a conversation that no longer has the hub as executor is left alone', async () => {
    conversations.findById.mockResolvedValue(conv(A, null));
    await hook.onExecutorLost(ctx);
    expect(conversations.lockById).not.toHaveBeenCalled();
    expect(conversations.save).not.toHaveBeenCalled();
  });

  it('gives up with an error (409) when the owner keeps changing: the hubs operation rolls back', async () => {
    conversations.findById.mockResolvedValue(conv(A));
    conversations.lockById.mockResolvedValue(conv(B));
    await expect(hook.onExecutorLost(ctx)).rejects.toMatchObject({
      constructor: ConflictError,
      code: 'conversation-owner-changing',
    });
    expect(conversations.lockById).toHaveBeenCalledTimes(3);
    expect(conversations.save).not.toHaveBeenCalled();
    expect(grants.removeFor).not.toHaveBeenCalled();
    expect(messages.requeueAckedBy).not.toHaveBeenCalled();
  });
});
