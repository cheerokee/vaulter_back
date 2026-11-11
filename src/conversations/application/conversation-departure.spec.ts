import type { ConversationCloudReserve } from './conversation-cloud-reserve.js';
import type { AuditLog } from '../../organizations/application/audit-log.js';
import { newId } from '../../shared/domain/id.js';
import type { ConversationScope } from '../domain/conversation-actor.js';
import type { ConversationMessageRepository } from '../domain/conversation-message.repository.js';
import type { ConversationKeyGrantRepository } from '../domain/conversation-key-grant.repository.js';
import type { ConversationParticipantRepository } from '../domain/conversation-participant.repository.js';
import type { ConversationRepository } from '../domain/conversation.repository.js';
import { Conversation } from '../domain/conversation.js';
import { ConversationDeparture } from './conversation-departure.js';
import type { ConversationExecutors } from './conversation-executors.js';

const as = <T>(x: unknown) => x as T;
const ORG = newId();
const OWNER = newId();
const OTHER = newId();
const HUB = newId();
const t0 = new Date('2026-11-09T10:00:00Z');
const t1 = new Date('2026-11-09T11:00:00Z');

const blob = () => {
  const b = Buffer.alloc(60, 0xab);
  b[0] = 0x01;
  return b.toString('base64url');
};

function conversation(participants: string[], executorHubId: string | null) {
  return Conversation.restore(
    {
      organizationId: ORG,
      spaceId: newId(),
      createdByUserId: OWNER,
      ownerUserId: OWNER,
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
      cloudAnswer: false,
      participantUserIds: participants,
      createdAt: t0,
      deletedAt: null,
    },
    newId(),
  );
}

describe('ConversationDeparture', () => {
  const calls: string[] = [];
  const conversations = {
    save: vi.fn(async (_s: ConversationScope, c: Conversation) => {
      calls.push(
        `save:owner=${c.ownerUserId === OWNER ? 'OWNER' : 'OTHER'}:executor=${c.executorHubId ? 'HUB' : 'null'}:rotation=${c.keyRotationRequired}:deleted=${c.deletedAt !== null}`,
      );
    }),
  };
  const participants = {
    listLive: vi.fn(),
    remove: vi.fn(async (_s: ConversationScope, _id: string, u: string) => {
      calls.push(`removeParticipation:${u === OWNER ? 'OWNER' : 'OTHER'}`);
      return true;
    }),
  };
  const grants = {
    removeFor: vi.fn(
      async (
        _s: ConversationScope,
        _id: string,
        r: { kind: string; userId?: string },
      ) => {
        calls.push(
          `removeGrants:${r.kind === 'hub' ? 'HUB' : r.userId === OWNER ? 'OWNER' : 'OTHER'}`,
        );
        return 1;
      },
    ),
  };
  const executors = { ownerOf: vi.fn() };
  const audit = { record: vi.fn() };
  const messages = {
    requeueAckedBy: vi.fn(
      async (
        _s: ConversationScope,
        _id: string,
        by: { kind: 'hub'; hubId: string } | { kind: 'cloud' },
      ) => {
        calls.push(
          `requeueAckedBy:${by.kind === 'hub' && by.hubId === HUB ? 'HUB' : by.kind}`,
        );
        return [] as string[];
      },
    ),
  };
  const departure = new ConversationDeparture(
    as<ConversationRepository>(conversations),
    as<ConversationParticipantRepository>(participants),
    as<ConversationKeyGrantRepository>(grants),
    as<ConversationExecutors>(executors),
    as<AuditLog>(audit),
    as<ConversationMessageRepository>(messages),
    as<ConversationCloudReserve>({
      requeued: vi.fn(),
      dropServerSide: vi.fn(),
    }),
  );
  const scope: ConversationScope = {
    organizationId: ORG,
    actor: { kind: 'user', userId: OWNER },
  };

  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
  });

  it('the owner of the executor hub leaves: new owner, executor out, and the own participation tombstone LAST', async () => {
    participants.listLive.mockResolvedValue([
      { userId: OWNER, joinedAt: t0 },
      { userId: OTHER, joinedAt: t1 },
    ]);
    executors.ownerOf.mockResolvedValue(OWNER);
    const c = conversation([OWNER, OTHER].sort(), HUB);
    const result = await departure.depart(scope, c, OWNER, {
      now: t1,
      actorId: OWNER,
    });
    expect(result).toEqual({
      ended: false,
      newOwnerUserId: OTHER,
      lostExecutorHubId: HUB,
    });
    expect(calls).toEqual([
      'save:owner=OTHER:executor=null:rotation=true:deleted=false',
      'removeGrants:HUB',
      // What the lost executor acknowledged and never answered goes back to the inbox.
      'requeueAckedBy:HUB',
      'removeGrants:OWNER',
      'removeParticipation:OWNER',
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'conversation.executor_lost' }),
    );
  });

  it('the last participant leaves: the conversation becomes a tombstone before the participation goes', async () => {
    participants.listLive.mockResolvedValue([{ userId: OWNER, joinedAt: t0 }]);
    executors.ownerOf.mockResolvedValue(null);
    const c = conversation([OWNER], null);
    const result = await departure.depart(scope, c, OWNER, {
      now: t1,
      actorId: OWNER,
    });
    expect(result.ended).toBe(true);
    expect(c.deletedAt).toEqual(t1);
    expect(calls).toEqual([
      'save:owner=OWNER:executor=null:rotation=true:deleted=true',
      'removeGrants:OWNER',
      'removeParticipation:OWNER',
    ]);
    expect(audit.record).not.toHaveBeenCalled();
  });
});
