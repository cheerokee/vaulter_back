import type { HubAuthContext } from '../../shared/application/hub-auth-context.js';
import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';
import { newId } from '../../shared/domain/id.js';
import type { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { SpaceStorage } from '../../spaces/application/space-storage.js';
import { SpaceStorageUsage } from '../../spaces/application/space-storage-usage.js';
import type { ConversationScope } from '../domain/conversation-actor.js';
import { ConversationMessage } from '../domain/conversation-message.js';
import type { ConversationMessageRepository } from '../domain/conversation-message.repository.js';
import type { ConversationRepository } from '../domain/conversation.repository.js';
import { Conversation } from '../domain/conversation.js';
import { AckMessageUseCase } from './ack-message.use-case.js';
import type { ConversationAccess } from './conversation-access.js';
import { DeleteMessageUseCase } from './delete-message.use-case.js';
import { SendMessageUseCase } from './send-message.use-case.js';

const as = <T>(x: unknown) => x as T;
const ORG = newId();
const SPACE = newId();
const HUB = newId();
const ANA = newId();
const BIA = newId();
const CONV = newId();
const DB_NOW = new Date('2026-11-10T12:00:00.123Z');
const GiB = 1024 ** 3;

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
      participantUserIds: [ANA, BIA].sort(),
      createdAt: new Date(),
      deletedAt: null,
    },
    CONV,
  );

const userScope: ConversationScope = {
  organizationId: ORG,
  actor: { kind: 'user', userId: ANA },
};
const hubScope: ConversationScope = {
  organizationId: ORG,
  actor: { kind: 'hub', hubId: HUB },
};
const hub: HubAuthContext = { hubId: HUB };

const stored = (
  author: ConversationScope['actor'],
  over: { conversationId?: string; body?: string; deleted?: boolean } = {},
) => {
  const m = ConversationMessage.create({
    id: newId(),
    organizationId: ORG,
    conversationId: over.conversationId ?? CONV,
    author,
    keyVersion: 2,
    encryptedBody: over.body ?? blob(),
    replacesMessageId: null,
    sentAt: DB_NOW,
    now: DB_NOW,
  });
  if (over.deleted) m.tombstone(DB_NOW);
  return m;
};

describe('message use cases', () => {
  const trace: string[] = [];
  let current: Conversation;
  let quotaBytes: number | null;
  let otherUsage: number;
  const found = new Map<string, ConversationMessage>();

  const access = {
    userScope: vi.fn(async () => {
      trace.push('userScope');
      return userScope;
    }),
    lock: vi.fn(async () => {
      trace.push('lockConversation');
      return current;
    }),
    lockForUser: vi.fn(async () => {
      trace.push('lockConversation');
      return { scope: userScope, conversation: current };
    }),
    findForHub: vi.fn(async () => {
      trace.push('findForHub');
      return { scope: hubScope, conversation: current };
    }),
    lockForHub: vi.fn(async () => {
      trace.push('lockConversation');
      return { scope: hubScope, conversation: current };
    }),
  };
  const spaceStorage = {
    lockQuota: vi.fn(async () => {
      trace.push('lockSpace');
      return quotaBytes;
    }),
  };
  const conversations = {
    save: vi.fn(async () => {
      trace.push('saveConversation');
    }),
  };
  const messages = {
    databaseNow: vi.fn(async () => DB_NOW),
    findById: vi.fn(async (_s: ConversationScope, id: string) => {
      trace.push(`find:${id}`);
      return found.get(id) ?? null;
    }),
    insertIfAbsent: vi.fn(
      async (_s: ConversationScope, m: ConversationMessage) => {
        trace.push('insert');
        found.set(m.id, m);
        return true;
      },
    ),
    save: vi.fn(async () => {
      trace.push('saveMessage');
    }),
  };
  const usage = new SpaceStorageUsage();
  usage.register('test', {
    usedBytes: async () => {
      trace.push('usedBytes');
      // What the trigger already counted: every inserted message plus the rest of the space.
      return (
        otherUsage +
        [...found.values()].reduce((sum, m) => sum + m.bodyBytes, 0)
      );
    },
  });
  const uow = {
    run: vi.fn(async (work: () => Promise<unknown>) => work()),
    setContext: vi.fn(async () => undefined),
  };

  const send = new SendMessageUseCase(
    as<ConversationAccess>(access),
    as<SpaceStorage>(spaceStorage),
    usage,
    as<ConversationRepository>(conversations),
    as<ConversationMessageRepository>(messages),
    as<UnitOfWork>(uow),
  );
  const ack = new AckMessageUseCase(
    as<ConversationAccess>(access),
    as<ConversationMessageRepository>(messages),
    as<UnitOfWork>(uow),
  );
  const del = new DeleteMessageUseCase(
    as<ConversationAccess>(access),
    as<ConversationMessageRepository>(messages),
    as<UnitOfWork>(uow),
  );

  const input = (over: Record<string, unknown> = {}) => ({
    id: newId(),
    keyVersion: 2,
    encryptedBody: blob(),
    replacesMessageId: null as string | null,
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    trace.length = 0;
    found.clear();
    current = conversation();
    quotaBytes = 10 * GiB;
    otherUsage = 0;
  });

  describe('send', () => {
    it('a person: space locked before the conversation, pending, last message at the database clock, usage read after the insert', async () => {
      const i = input();
      const { view, created } = await send.byUser(
        { userId: ANA, sessionId: newId() },
        SPACE,
        CONV,
        i,
      );
      expect(created).toBe(true);
      expect(view).toMatchObject({
        id: i.id,
        conversationId: CONV,
        authorUserId: ANA,
        authorHubId: null,
        keyVersion: 2,
        pending: true,
        ackedAt: null,
        sentAt: DB_NOW,
      });
      expect(current.lastMessageAt).toEqual(DB_NOW);
      expect(trace).toEqual([
        'userScope',
        'lockSpace',
        'lockConversation',
        `find:${i.id}`,
        'insert',
        'saveConversation',
        'usedBytes',
      ]);
      expect(uow.setContext).toHaveBeenCalledWith({ userId: ANA });
    });

    it('the executor hub: born acknowledged', async () => {
      const { view } = await send.byHub(hub, CONV, input());
      expect(view).toMatchObject({
        authorHubId: HUB,
        authorUserId: null,
        pending: false,
        ackedAt: DB_NOW,
      });
      expect(trace.slice(0, 3)).toEqual([
        'findForHub',
        'lockSpace',
        'lockConversation',
      ]);
    });

    it('resending the same id with the same content is the same answer; nothing is written again', async () => {
      const i = input();
      const actor = { userId: ANA, sessionId: newId() };
      await send.byUser(actor, SPACE, CONV, i);
      vi.clearAllMocks();
      current = conversation({ keyRotationRequired: true }); // even after the rotation flag went up
      const again = await send.byUser(actor, SPACE, CONV, i);
      expect(again.created).toBe(false);
      expect(again.view.id).toBe(i.id);
      expect(messages.insertIfAbsent).not.toHaveBeenCalled();
      expect(conversations.save).not.toHaveBeenCalled();
    });

    it('the same id with other content, from someone else or in another conversation: 409 message-id-conflict', async () => {
      const mine = stored({ kind: 'user', userId: ANA });
      found.set(mine.id, mine);
      const actor = { userId: ANA, sessionId: newId() };
      await expect(
        send.byUser(
          actor,
          SPACE,
          CONV,
          input({ id: mine.id, encryptedBody: blob(60, 0xcd) }),
        ),
      ).rejects.toMatchObject({
        constructor: ConflictError,
        code: 'message-id-conflict',
      });
      const hers = stored({ kind: 'user', userId: BIA });
      found.set(hers.id, hers);
      await expect(
        send.byUser(
          actor,
          SPACE,
          CONV,
          input({ id: hers.id, encryptedBody: hers.encryptedBody }),
        ),
      ).rejects.toMatchObject({ code: 'message-id-conflict' });
      const elsewhere = stored(
        { kind: 'user', userId: ANA },
        { conversationId: newId() },
      );
      found.set(elsewhere.id, elsewhere);
      await expect(
        send.byUser(
          actor,
          SPACE,
          CONV,
          input({ id: elsewhere.id, encryptedBody: elsewhere.encryptedBody }),
        ),
      ).rejects.toMatchObject({ code: 'message-id-conflict' });
      expect(messages.insertIfAbsent).not.toHaveBeenCalled();
    });

    it('an id the scope cannot see (another conversation or organization): insert says false -> 409, never "already sent"', async () => {
      messages.insertIfAbsent.mockResolvedValueOnce(false);
      await expect(
        send.byUser({ userId: ANA, sessionId: newId() }, SPACE, CONV, input()),
      ).rejects.toMatchObject({ code: 'message-id-conflict' });
      expect(conversations.save).not.toHaveBeenCalled();
    });

    it('a pending rotation or a stale version: 409 and nothing written', async () => {
      current = conversation({ keyRotationRequired: true });
      const actor = { userId: ANA, sessionId: newId() };
      await expect(
        send.byUser(actor, SPACE, CONV, input()),
      ).rejects.toMatchObject({ code: 'conversation-key-rotation-required' });
      current = conversation();
      await expect(
        send.byUser(actor, SPACE, CONV, input({ keyVersion: 1 })),
      ).rejects.toMatchObject({
        code: 'conversation-key-version-stale',
        details: { expectedVersion: 2 },
      });
      expect(messages.insertIfAbsent).not.toHaveBeenCalled();
    });

    it('a full space: 422 space-storage-full with the missing bytes (the unit of work rolls the insert back)', async () => {
      quotaBytes = 1 * GiB;
      otherUsage = 1 * GiB - 10;
      const i = input();
      await expect(
        send.byUser({ userId: ANA, sessionId: newId() }, SPACE, CONV, i),
      ).rejects.toMatchObject({
        constructor: DomainValidationError,
        code: 'space-storage-full',
        details: { missingBytes: 60 - 10 },
      });
    });

    it('a malformed or too large body is 422 before any lock', async () => {
      const actor = { userId: ANA, sessionId: newId() };
      await expect(
        send.byUser(
          actor,
          SPACE,
          CONV,
          input({ encryptedBody: 'not base64!' }),
        ),
      ).rejects.toMatchObject({ code: 'encrypted-blob-invalid' });
      await expect(
        send.byUser(actor, SPACE, CONV, input({ encryptedBody: blob(65_537) })),
      ).rejects.toMatchObject({ code: 'message-too-large' });
      await expect(
        send.byUser(actor, SPACE, CONV, input({ id: 'x' })),
      ).rejects.toMatchObject({ code: 'message-id-invalid' });
      expect(trace).toEqual([]);
    });

    it("edit = a new message replacing one of mine, which becomes a tombstone; someone else's is 403, unknown is 422", async () => {
      const actor = { userId: ANA, sessionId: newId() };
      const original = stored({ kind: 'user', userId: ANA });
      found.set(original.id, original);
      const edit = input({ replacesMessageId: original.id });
      const { view } = await send.byUser(actor, SPACE, CONV, edit);
      expect(view.replacesMessageId).toBe(original.id);
      expect(original.deletedAt).toEqual(DB_NOW);
      expect(messages.save).toHaveBeenCalledWith(userScope, original);

      const hers = stored({ kind: 'user', userId: BIA });
      found.set(hers.id, hers);
      await expect(
        send.byUser(actor, SPACE, CONV, input({ replacesMessageId: hers.id })),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(
        send.byUser(actor, SPACE, CONV, input({ replacesMessageId: newId() })),
      ).rejects.toMatchObject({ code: 'message-replaces-invalid' });
      // Already replaced (a tombstone) cannot be edited again.
      await expect(
        send.byUser(
          actor,
          SPACE,
          CONV,
          input({ replacesMessageId: original.id }),
        ),
      ).rejects.toMatchObject({ code: 'message-replaces-invalid' });
    });
  });

  describe('ack', () => {
    it('the executor acknowledges a pending message once (the first ack wins)', async () => {
      const m = stored({ kind: 'user', userId: ANA });
      found.set(m.id, m);
      const first = await ack.execute(hub, CONV, m.id);
      expect(first).toMatchObject({ pending: false, ackedAt: DB_NOW });
      expect(messages.save).toHaveBeenCalledTimes(1);
      await ack.execute(hub, CONV, m.id);
      expect(messages.save).toHaveBeenCalledTimes(1);
    });

    it('a hub that is not the executor: 404 conversation-not-found; unknown, deleted or of another conversation: 404 message-not-found', async () => {
      current = Conversation.restore(
        { ...conversation().snapshot(), executorHubId: newId() },
        CONV,
      );
      const m = stored({ kind: 'user', userId: ANA });
      found.set(m.id, m);
      await expect(ack.execute(hub, CONV, m.id)).rejects.toMatchObject({
        code: 'conversation-not-found',
      });
      current = conversation();
      const deleted = stored({ kind: 'user', userId: ANA }, { deleted: true });
      const elsewhere = stored(
        { kind: 'user', userId: ANA },
        { conversationId: newId() },
      );
      found.set(deleted.id, deleted);
      found.set(elsewhere.id, elsewhere);
      for (const id of [newId(), deleted.id, elsewhere.id]) {
        await expect(ack.execute(hub, CONV, id)).rejects.toMatchObject({
          constructor: NotFoundError,
          code: 'message-not-found',
        });
      }
      expect(messages.save).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('each one deletes only their own (403 otherwise); deleting again is a no-op', async () => {
      const mine = stored({ kind: 'user', userId: ANA });
      const hers = stored({ kind: 'user', userId: BIA });
      found.set(mine.id, mine);
      found.set(hers.id, hers);
      const actor = { userId: ANA, sessionId: newId() };
      await del.byUser(actor, SPACE, CONV, mine.id);
      expect(mine.deletedAt).toEqual(DB_NOW);
      expect(messages.save).toHaveBeenCalledTimes(1);
      await del.byUser(actor, SPACE, CONV, mine.id);
      expect(messages.save).toHaveBeenCalledTimes(1);
      await expect(
        del.byUser(actor, SPACE, CONV, hers.id),
      ).rejects.toMatchObject({
        constructor: PermissionDeniedError,
        code: 'not-conversation-owner',
      });
      await expect(
        del.byUser(actor, SPACE, CONV, newId()),
      ).rejects.toMatchObject({ code: 'message-not-found' });
    });

    it("the executor deletes its own messages, not a person's", async () => {
      const own = stored({ kind: 'hub', hubId: HUB });
      const hers = stored({ kind: 'user', userId: BIA });
      found.set(own.id, own);
      found.set(hers.id, hers);
      await del.byHub(hub, CONV, own.id);
      expect(own.deletedAt).toEqual(DB_NOW);
      await expect(del.byHub(hub, CONV, hers.id)).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
    });
  });
});
