import type { HubDirectory } from '../../hubs/application/hub-directory.js';
import { ConflictError, NotFoundError } from '../../shared/domain/errors.js';
import { newId } from '../../shared/domain/id.js';
import type { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { ConversationScope } from '../domain/conversation-actor.js';
import { conversationNotFound } from '../domain/conversation-errors.js';
import { AGENT_ACK_LEASE_MS } from '../domain/conversation-limits.js';
import { ConversationMessage } from '../domain/conversation-message.js';
import type { ConversationMessageRepository } from '../domain/conversation-message.repository.js';
import { Conversation } from '../domain/conversation.js';
import { AgentTurn } from './agent-turn.js';
import type { ConversationAccess } from './conversation-access.js';
import { HubConversationScope } from './hub-conversation-scope.js';

const as = <T>(x: unknown) => x as T;
const ORG = newId();
const SPACE = newId();
const PC = newId();
const OTHER_HUB = newId();
const OLIVIA = newId(); // owner of the pc
const ANA = newId();
const CONV = newId();
const ACKED_AT = new Date('2026-11-21T12:00:00.000Z');
const blob = () => {
  const b = Buffer.alloc(60, 0xab);
  b[0] = 0x01;
  return b.toString('base64url');
};

const conversation = (over: { executorHubId?: string } = {}) =>
  Conversation.restore(
    {
      organizationId: ORG,
      spaceId: SPACE,
      createdByUserId: ANA,
      ownerUserId: ANA,
      executorHubId: over.executorHubId ?? PC,
      state: 'na_fila',
      lastMessageAt: null,
      currentKeyVersion: 1,
      keyRotationRequired: false,
      encryptedHeader: blob(),
      headerKeyVersion: 1,
      movedFromConversationId: null,
      cloudReserve: true,
      cloudReserveDeclined: false,
      cloudAnswer: false,
      participantUserIds: [ANA, OLIVIA].sort(),
      createdAt: new Date(),
      deletedAt: null,
    },
    CONV,
  );

const hubScope: ConversationScope = {
  organizationId: ORG,
  actor: { kind: 'hub', hubId: PC },
};

/** A person's message acked by `ackedBy` (a pc ack carries the lease). */
const message = (
  over: {
    author?: ConversationMessage['author'];
    ackedBy?: string | null;
    agentLease?: boolean;
  } = {},
) => {
  const m = ConversationMessage.create({
    id: newId(),
    organizationId: ORG,
    conversationId: CONV,
    author: over.author ?? { kind: 'user', userId: ANA },
    keyVersion: 1,
    encryptedBody: blob(),
    replacesMessageId: null,
    sentAt: new Date(ACKED_AT.getTime() - 1000),
    now: new Date(ACKED_AT.getTime() - 1000),
  });
  const ackedBy = over.ackedBy === undefined ? PC : over.ackedBy;
  if (ackedBy) {
    m.ack(
      ACKED_AT,
      { kind: 'hub', hubId: ackedBy },
      { agentLease: over.agentLease ?? true },
    );
  }
  return m;
};

describe('AgentTurn', () => {
  let current: Conversation;
  let dbNow: Date;
  let answered: boolean;
  const found = new Map<string, ConversationMessage>();

  const access = {
    findForHub: vi.fn(async () => ({ scope: hubScope, conversation: current })),
    lockForHub: vi.fn(async () => ({ scope: hubScope, conversation: current })),
  };
  const messages = {
    databaseNow: vi.fn(async () => dbNow),
    findById: vi.fn(
      async (_s: ConversationScope, id: string) => found.get(id) ?? null,
    ),
    answeredBy: vi.fn(async () => answered),
    save: vi.fn(async () => undefined),
  };
  const hubs = { ownerOf: vi.fn(async () => OLIVIA) };
  const uow = {
    run: vi.fn(async (work: () => Promise<unknown>) => work()),
    setContext: vi.fn(async () => undefined),
  };
  const turn = new AgentTurn(
    new HubConversationScope(as<ConversationAccess>(access)),
    as<ConversationAccess>(access),
    as<ConversationMessageRepository>(messages),
    as<HubDirectory>(hubs),
    as<UnitOfWork>(uow),
  );

  beforeEach(() => {
    vi.clearAllMocks();
    found.clear();
    current = conversation();
    dbNow = new Date(ACKED_AT.getTime() + 60_000);
    answered = false;
  });

  describe('requireTurn', () => {
    it('the message the pc acked, unanswered and within the lease: the view', async () => {
      const m = message();
      found.set(m.id, m);
      await expect(turn.requireTurn(PC, CONV, m.id)).resolves.toEqual({
        organizationId: ORG,
        spaceId: SPACE,
        conversationId: CONV,
        messageId: m.id,
        authorUserId: ANA,
        hubOwnerUserId: OLIVIA,
        cloudReserve: true,
      });
      // "Answered by the agent" = a hub message whose answersMessageId is this one (not any later hub message).
      expect(messages.answeredBy).toHaveBeenCalledWith(hubScope, CONV, m.id);
    });

    it('not executor or unapproved link = 404 conversation-not-found', async () => {
      const m = message();
      found.set(m.id, m);
      current = conversation({ executorHubId: OTHER_HUB });
      await expect(turn.requireTurn(PC, CONV, m.id)).rejects.toMatchObject({
        constructor: NotFoundError,
        code: 'conversation-not-found',
      });
      // No approved link: the conversation is not found in any organization of the hub.
      current = conversation();
      access.findForHub.mockRejectedValueOnce(conversationNotFound());
      await expect(turn.requireTurn(PC, CONV, m.id)).rejects.toMatchObject({
        code: 'conversation-not-found',
      });
      await expect(
        turn.requireTurn('not-a-uuid', CONV, m.id),
      ).rejects.toMatchObject({ code: 'conversation-not-found' });
    });

    it("message of another hub, not a person's, already answered by the executor, or lease expired = 409 brain-step-not-owned", async () => {
      const ofAnotherHub = message({ ackedBy: OTHER_HUB });
      const fromHub = message({ author: { kind: 'hub', hubId: PC } });
      const pending = message({ ackedBy: null });
      const withoutLease = message({ agentLease: false });
      const unknown = newId();
      for (const m of [ofAnotherHub, fromHub, pending, withoutLease]) {
        found.set(m.id, m);
      }
      for (const id of [
        ofAnotherHub.id,
        fromHub.id,
        pending.id,
        withoutLease.id,
        unknown,
      ]) {
        await expect(turn.requireTurn(PC, CONV, id)).rejects.toMatchObject({
          constructor: ConflictError,
          code: 'brain-step-not-owned',
        });
      }

      const mine = message();
      found.set(mine.id, mine);
      answered = true;
      await expect(turn.requireTurn(PC, CONV, mine.id)).rejects.toMatchObject({
        code: 'brain-step-not-owned',
      });
      answered = false;
      // The lease ends exactly at acked_at + 15 min (database clock): at that instant it is over.
      dbNow = new Date(ACKED_AT.getTime() + AGENT_ACK_LEASE_MS);
      await expect(turn.requireTurn(PC, CONV, mine.id)).rejects.toMatchObject({
        code: 'brain-step-not-owned',
      });
    });
  });

  describe('renewLease', () => {
    it('moves the lease to now + 15 min (database clock), under the conversation lock', async () => {
      const m = message();
      found.set(m.id, m);
      dbNow = new Date(ACKED_AT.getTime() + 10 * 60_000);
      const { leaseUntil } = await turn.renewLease(PC, CONV, m.id);
      expect(leaseUntil).toEqual(
        new Date(dbNow.getTime() + AGENT_ACK_LEASE_MS),
      );
      expect(m.ackedLeaseUntil).toEqual(leaseUntil);
      expect(access.lockForHub).toHaveBeenCalledWith(PC, CONV, 'no-key-update');
      expect(messages.save).toHaveBeenCalledWith(hubScope, m);
    });

    it('only for the hub that acked, before the lease ends and without an answer: 409 brain-step-not-owned otherwise', async () => {
      const ofAnotherHub = message({ ackedBy: OTHER_HUB });
      found.set(ofAnotherHub.id, ofAnotherHub);
      await expect(
        turn.renewLease(PC, CONV, ofAnotherHub.id),
      ).rejects.toMatchObject({ code: 'brain-step-not-owned' });

      const mine = message();
      found.set(mine.id, mine);
      answered = true;
      await expect(turn.renewLease(PC, CONV, mine.id)).rejects.toMatchObject({
        code: 'brain-step-not-owned',
      });
      answered = false;
      dbNow = new Date(ACKED_AT.getTime() + AGENT_ACK_LEASE_MS + 1);
      await expect(turn.renewLease(PC, CONV, mine.id)).rejects.toMatchObject({
        code: 'brain-step-not-owned',
      });
      expect(messages.save).not.toHaveBeenCalled();

      current = conversation({ executorHubId: OTHER_HUB });
      await expect(turn.renewLease(PC, CONV, mine.id)).rejects.toMatchObject({
        code: 'conversation-not-found',
      });
    });
  });
});
