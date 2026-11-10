import type { INestApplication } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { ConversationAttachment } from '../../src/conversations/domain/conversation-attachment.js';
import { ConversationAttachmentRepository } from '../../src/conversations/domain/conversation-attachment.repository.js';
import type { ConversationScope } from '../../src/conversations/domain/conversation-actor.js';
import { ConversationKeyGrantRepository } from '../../src/conversations/domain/conversation-key-grant.repository.js';
import { ConversationMessage } from '../../src/conversations/domain/conversation-message.js';
import { ConversationMessageRepository } from '../../src/conversations/domain/conversation-message.repository.js';
import { ConversationParticipantRepository } from '../../src/conversations/domain/conversation-participant.repository.js';
import { Conversation } from '../../src/conversations/domain/conversation.js';
import { ConversationRepository } from '../../src/conversations/domain/conversation.repository.js';
import { Hub } from '../../src/hubs/domain/hub.js';
import { HubRepository } from '../../src/hubs/domain/hub.repository.js';
import { DEFAULT_KDF_PARAMS } from '../../src/identity/domain/kdf-params.js';
import { User } from '../../src/identity/domain/user.js';
import { UserRepository } from '../../src/identity/domain/user.repository.js';
import type { OrgRoleKey } from '../../src/organizations/domain/membership.js';
import { MembershipRepository } from '../../src/organizations/domain/membership.repository.js';
import { Organization } from '../../src/organizations/domain/organization.js';
import { OrganizationRepository } from '../../src/organizations/domain/organization.repository.js';
import { RoleAssignmentRepository } from '../../src/organizations/domain/role-assignment.repository.js';
import { newId } from '../../src/shared/domain/id.js';
import {
  UnitOfWork,
  runWithContext,
  type UnitOfWorkContext,
} from '../../src/shared/infra/db/unit-of-work.js';
import { Space } from '../../src/spaces/domain/space.js';
import { SpaceRepository } from '../../src/spaces/domain/space.repository.js';
import { createTestApp, resetDatabase } from '../setup/test-app.js';
import { testRecoveryFields } from '../support/client-crypto.js';
import { createHubIdentity } from '../support/hub-crypto.js';

const now = new Date('2026-11-09T12:00:00.000Z');
const later = (s: number) => new Date(now.getTime() + s * 1000);

const b64 = (n: number, first?: number) => {
  const b = Buffer.alloc(n, 0xab);
  if (first !== undefined) b[0] = first;
  return b.toString('base64url');
};
// Formato das cópias trancadas (81 bytes, 108 chars) e dos blobs cifrados (0x01 ‖ ...): o backend só confere a forma.
const wrapped = (fill: number) => {
  const b = Buffer.alloc(81, fill);
  b[0] = 0x01;
  return b.toString('base64url');
};
const blob = (bytes: number) => b64(bytes, 0x01);

const TABLES = [
  'conversations',
  'conversation_participants',
  'conversation_key_grants',
  'conversation_messages',
  'conversation_attachments',
] as const;

// Sempre pelo papel de runtime (o DataSource da aplicação): o dono das tabelas é superusuário e ignora o RLS.
describe('conversations: tables and row-level security (e2e, app role)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let uow: UnitOfWork;
  let users: UserRepository;
  let orgs: OrganizationRepository;
  let members: MembershipRepository;
  let orgRoles: RoleAssignmentRepository;
  let spaces: SpaceRepository;
  let hubs: HubRepository;
  let conversations: ConversationRepository;
  let participants: ConversationParticipantRepository;
  let grants: ConversationKeyGrantRepository;
  let messages: ConversationMessageRepository;
  let attachments: ConversationAttachmentRepository;

  const makeUser = async (email: string): Promise<string> => {
    const user = User.register({
      name: email.split('@')[0]!,
      email,
      authHash: '$argon2id$v=19$m=19456,t=2,p=1$fake',
      kdfSalt: b64(16),
      kdfParams: { ...DEFAULT_KDF_PARAMS },
      publicKey: b64(32),
      encryptedPrivateKey: b64(73, 0x01),
      ...testRecoveryFields(),
      now,
    });
    await users.create(user);
    return user.id;
  };

  const makeOrg = async (name: string, people: string[]): Promise<string> => {
    const org = Organization.create({ name, now });
    await uow.run(async () => {
      await orgs.create(org);
      for (const [i, u] of people.entries()) {
        const role: OrgRoleKey = i === 0 ? 'org_admin' : 'org_member';
        await members.add(org.id, u, now);
        await orgRoles.assignOrgRole(org.id, u, role, null);
      }
    });
    return org.id;
  };

  const makeHub = async (ownerUserId: string): Promise<string> => {
    const identity = await createHubIdentity();
    const hub = Hub.restore(
      {
        ownerUserId,
        name: 'Casa',
        signingPublicKey: identity.signingPublicKey,
        encryptionPublicKey: identity.encryptionPublicKey,
        lastSeenAt: null,
        deletedAt: null,
        createdAt: now,
      },
      newId(),
    );
    await uow.run(() =>
      uow.withContext({ userId: ownerUserId }, () => hubs.create(hub)),
    );
    return hub.id;
  };

  const userScope = (
    organizationId: string,
    userId: string,
  ): ConversationScope => ({
    organizationId,
    actor: { kind: 'user', userId },
  });
  const hubScope = (
    organizationId: string,
    hubId: string,
  ): ConversationScope => ({
    organizationId,
    actor: { kind: 'hub', hubId },
  });

  // SQL direto pelo papel de runtime, com o contexto dado. UPDATE devolve [linhas, contagem].
  const asApp = (
    ctx: UnitOfWorkContext,
    sql: string,
    params: unknown[] = [],
  ): Promise<Record<string, unknown>[]> =>
    runWithContext(ds, ctx, (m) => m.query(sql, params));

  const updatedCount = (raw: unknown) => (raw as [unknown[], number])[1];

  const visibleCounts = async (ctx: UnitOfWorkContext) => {
    const out: Record<string, number> = {};
    for (const t of TABLES) {
      const rows = await asApp(ctx, `SELECT count(*)::int AS n FROM "${t}"`);
      out[t] = rows[0]!.n as number;
    }
    return out;
  };

  const pgCode = (e: unknown) =>
    e instanceof QueryFailedError
      ? (e.driverError as { code?: string }).code
      : undefined;

  // Ana (dona do assunto e do Hub executor) e Bia participam; Caio é membro da organização e nunca participou;
  // o Hub do Caio não é executor; Davi é de outra organização.
  const seed = async () => {
    const ana = await makeUser('ana@x.com');
    const bia = await makeUser('bia@x.com');
    const caio = await makeUser('caio@x.com');
    const davi = await makeUser('davi@x.com');
    const orgA = await makeOrg('A', [ana, bia, caio]);
    const orgB = await makeOrg('B', [davi]);
    const space = Space.create({ organizationId: orgA, name: 'Casa', now });
    await spaces.create(space);
    const hub = await makeHub(ana);
    const caioHub = await makeHub(caio);

    const conversation = Conversation.create({
      id: newId(),
      organizationId: orgA,
      spaceId: space.id,
      createdByUserId: ana,
      ownerUserId: ana,
      executorHubId: hub,
      state: 'na_fila',
      encryptedHeader: blob(120),
      now,
    });
    const asAna = userScope(orgA, ana);
    const asHub = hubScope(orgA, hub);
    await uow.run(async () => {
      await conversations.create(asAna, conversation);
      await participants.add(asAna, conversation.id, bia, later(1));
      for (const [recipient, fill] of [
        [{ kind: 'user', userId: ana }, 1],
        [{ kind: 'user', userId: bia }, 2],
        [{ kind: 'hub', hubId: hub }, 3],
      ] as const) {
        await grants.put(asAna, conversation.id, {
          keyVersion: 1,
          recipient,
          wrappedKey: wrapped(fill),
        });
      }
    });
    const fromAna = ConversationMessage.create({
      id: newId(),
      organizationId: orgA,
      conversationId: conversation.id,
      author: { kind: 'user', userId: ana },
      keyVersion: 1,
      encryptedBody: blob(200),
      replacesMessageId: null,
      sentAt: later(2),
      now: later(2),
    });
    expect(await messages.insertIfAbsent(asAna, fromAna)).toBe(true);
    const fromHub = ConversationMessage.create({
      id: newId(),
      organizationId: orgA,
      conversationId: conversation.id,
      author: { kind: 'hub', hubId: hub },
      keyVersion: 1,
      encryptedBody: blob(300),
      replacesMessageId: null,
      sentAt: later(3),
      now: later(3),
    });
    expect(await messages.insertIfAbsent(asHub, fromHub)).toBe(true);
    const attachment = ConversationAttachment.create({
      id: newId(),
      organizationId: orgA,
      conversationId: conversation.id,
      messageId: fromAna.id,
      keyVersion: 1,
      sizeBytes: 5000,
      sha256: 'b'.repeat(64),
      uploadExpiresAt: later(3600),
    });
    await attachments.create(asAna, attachment);
    return {
      ana,
      bia,
      caio,
      davi,
      orgA,
      orgB,
      space: space.id,
      hub,
      caioHub,
      conversationId: conversation.id,
      fromAna,
      fromHub,
      attachment,
    };
  };

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
    uow = app.get(UnitOfWork);
    users = app.get(UserRepository, { strict: false });
    orgs = app.get(OrganizationRepository, { strict: false });
    members = app.get(MembershipRepository, { strict: false });
    orgRoles = app.get(RoleAssignmentRepository, { strict: false });
    spaces = app.get(SpaceRepository, { strict: false });
    hubs = app.get(HubRepository, { strict: false });
    conversations = app.get(ConversationRepository);
    participants = app.get(ConversationParticipantRepository);
    grants = app.get(ConversationKeyGrantRepository);
    messages = app.get(ConversationMessageRepository);
    attachments = app.get(ConversationAttachmentRepository);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase();
  });

  it('participants and the executor see the rows of the five tables', async () => {
    const s = await seed();
    const all = {
      conversations: 1,
      conversation_participants: 2,
      conversation_key_grants: 3,
      conversation_messages: 2,
      conversation_attachments: 1,
    };
    expect(
      await visibleCounts({ organizationId: s.orgA, userId: s.ana }),
    ).toEqual(all);
    expect(
      await visibleCounts({ organizationId: s.orgA, userId: s.bia }),
    ).toEqual(all);
    expect(
      await visibleCounts({ organizationId: s.orgA, hubId: s.hub }),
    ).toEqual(all);

    const seen = await conversations.findById(
      userScope(s.orgA, s.bia),
      s.conversationId,
    );
    expect(seen?.participantUserIds).toEqual([s.ana, s.bia].sort());
    expect(seen?.executorHubId).toBe(s.hub);
    expect(
      await participants.listLive(hubScope(s.orgA, s.hub), s.conversationId),
    ).toEqual([
      { userId: s.ana, joinedAt: now },
      { userId: s.bia, joinedAt: later(1) },
    ]);
    expect(
      (
        await grants.listFor(hubScope(s.orgA, s.hub), s.conversationId, {
          kind: 'hub',
          hubId: s.hub,
        })
      ).map((g) => g.keyVersion),
    ).toEqual([1]);
    const found = await messages.findById(
      userScope(s.orgA, s.bia),
      s.fromHub.id,
    );
    expect(found?.pending).toBe(false);
    expect(found?.bodyBytes).toBe(300);
    expect(
      (await attachments.findById(hubScope(s.orgA, s.hub), s.attachment.id))
        ?.sizeBytes,
    ).toBe(5000);
  });

  // Review Focus 1.
  it('a member of the organization who does not participate sees no row of the five tables', async () => {
    const s = await seed();
    const none = Object.fromEntries(TABLES.map((t) => [t, 0]));
    expect(
      await visibleCounts({ organizationId: s.orgA, userId: s.caio }),
    ).toEqual(none);
    // Um Hub que não é o executor (nem o do Caio), outra organização, contexto vazio: nada.
    expect(
      await visibleCounts({ organizationId: s.orgA, hubId: s.caioHub }),
    ).toEqual(none);
    expect(
      await visibleCounts({ organizationId: s.orgB, userId: s.ana }),
    ).toEqual(none);
    expect(
      await visibleCounts({ organizationId: s.orgA, userId: s.davi }),
    ).toEqual(none);
    expect(await visibleCounts({ userId: s.ana })).toEqual(none);
    expect(await visibleCounts({ organizationId: s.orgA })).toEqual(none);

    const asCaio = userScope(s.orgA, s.caio);
    expect(await conversations.findById(asCaio, s.conversationId)).toBeNull();
    expect(await messages.findById(asCaio, s.fromAna.id)).toBeNull();
    expect(await attachments.findById(asCaio, s.attachment.id)).toBeNull();
    expect(await participants.listLive(asCaio, s.conversationId)).toEqual([]);
    expect(
      await grants.listFor(asCaio, s.conversationId, {
        kind: 'user',
        userId: s.ana,
      }),
    ).toEqual([]);
    expect(await messages.listPending(asCaio, s.conversationId)).toEqual([]);
  });

  it('a non-participant cannot write: no self-join, no message, no key copy, no update, no conversation in someone else`s name', async () => {
    const s = await seed();
    const asCaio = userScope(s.orgA, s.caio);
    const caioCtx = { organizationId: s.orgA, userId: s.caio, hubId: '' };

    await expect(
      participants.add(asCaio, s.conversationId, s.caio, later(10)),
    ).rejects.toSatisfy((e) => pgCode(e) === '42501');
    await expect(
      grants.put(asCaio, s.conversationId, {
        keyVersion: 1,
        recipient: { kind: 'user', userId: s.caio },
        wrappedKey: wrapped(9),
      }),
    ).rejects.toSatisfy((e) => pgCode(e) === '42501');
    const intrusive = ConversationMessage.create({
      id: newId(),
      organizationId: s.orgA,
      conversationId: s.conversationId,
      author: { kind: 'user', userId: s.caio },
      keyVersion: 1,
      encryptedBody: blob(100),
      replacesMessageId: null,
      sentAt: later(10),
      now: later(10),
    });
    await expect(messages.insertIfAbsent(asCaio, intrusive)).rejects.toSatisfy(
      (e) => pgCode(e) === '42501',
    );
    for (const table of TABLES) {
      const key = table === 'conversations' ? 'id' : 'conversation_id';
      const raw = await asApp(
        caioCtx,
        `UPDATE "${table}" SET deleted_at = now() WHERE "${key}" = $1`,
        [s.conversationId],
      );
      expect(updatedCount(raw)).toBe(0);
    }
    // Criar uma conversa com outra pessoa como dona (ou outro Hub como executor) não passa.
    const forged = Conversation.create({
      id: newId(),
      organizationId: s.orgA,
      spaceId: s.space,
      createdByUserId: s.caio,
      ownerUserId: s.ana,
      executorHubId: s.hub,
      state: 'na_fila',
      encryptedHeader: blob(60),
      now,
    });
    await expect(conversations.create(asCaio, forged)).rejects.toSatisfy(
      (e) => pgCode(e) === '42501',
    );
    await expect(
      conversations.create(hubScope(s.orgA, s.caioHub), forged),
    ).rejects.toSatisfy((e) => pgCode(e) === '42501');
    expect(
      await visibleCounts({ organizationId: s.orgA, userId: s.ana }),
    ).toMatchObject({
      conversations: 1,
      conversation_participants: 2,
      conversation_key_grants: 3,
      conversation_messages: 2,
    });
  });

  it('someone who leaves loses the conversation at once and keeps reading only their own tombstones', async () => {
    const s = await seed();
    const asBia = userScope(s.orgA, s.bia);
    const before = (await conversations.findById(asBia, s.conversationId))!;
    await uow.run(async () => {
      // Tudo que ela grava na conversa vem antes da lápide da própria participação.
      expect(
        await grants.removeFor(asBia, s.conversationId, {
          kind: 'user',
          userId: s.bia,
        }),
      ).toBe(1);
      expect(await participants.remove(asBia, s.conversationId, s.bia)).toBe(
        true,
      );
    });
    // Gravar na conversa depois de sair não é um no-op silencioso.
    before.markRotationRequired();
    await expect(conversations.save(asBia, before)).rejects.toMatchObject({
      code: 'conversation-not-found',
    });

    const ana = await conversations.findById(
      userScope(s.orgA, s.ana),
      s.conversationId,
    );
    expect(ana?.participantUserIds).toEqual([s.ana]);
    expect(await conversations.findById(asBia, s.conversationId)).toBeNull();
    const biaCtx = { organizationId: s.orgA, userId: s.bia };
    expect(await visibleCounts(biaCtx)).toEqual({
      conversations: 0,
      conversation_participants: 1,
      conversation_key_grants: 1,
      conversation_messages: 0,
      conversation_attachments: 0,
    });
    const own = await asApp(
      biaCtx,
      `SELECT user_id, deleted_at IS NOT NULL AS gone FROM conversation_participants`,
    );
    expect(own).toEqual([{ user_id: s.bia, gone: true }]);
    // Não dá para se reativar nem reaver a cópia.
    expect(
      updatedCount(
        await asApp(
          biaCtx,
          `UPDATE conversation_participants SET deleted_at = NULL WHERE user_id = $1`,
          [s.bia],
        ),
      ),
    ).toBe(0);
    expect(
      updatedCount(
        await asApp(
          biaCtx,
          `UPDATE conversation_key_grants SET deleted_at = NULL WHERE user_id = $1`,
          [s.bia],
        ),
      ),
    ).toBe(0);
    // A própria lápide aparece para ela, mas reativá-la exige a conversa visível: 404, nunca um no-op silencioso.
    await expect(
      participants.add(asBia, s.conversationId, s.bia, later(20)),
    ).rejects.toMatchObject({ code: 'conversation-not-found' });
  });

  it('the owner removes and re-adds a participant: the same row comes back and participant_user_ids follows', async () => {
    const s = await seed();
    const asAna = userScope(s.orgA, s.ana);
    const rowId = async () =>
      (
        await asApp(
          { organizationId: s.orgA, userId: s.ana },
          `SELECT id FROM conversation_participants WHERE user_id = $1`,
          [s.bia],
        )
      ).map((r) => r.id);
    const before = await rowId();
    expect(await participants.remove(asAna, s.conversationId, s.bia)).toBe(
      true,
    );
    expect(await participants.remove(asAna, s.conversationId, s.bia)).toBe(
      false,
    );
    expect(
      (await conversations.findById(asAna, s.conversationId))
        ?.participantUserIds,
    ).toEqual([s.ana]);
    await participants.add(asAna, s.conversationId, s.bia, later(30));
    await participants.add(asAna, s.conversationId, s.bia, later(40));
    expect(await rowId()).toEqual(before);
    expect(await participants.listLive(asAna, s.conversationId)).toEqual([
      { userId: s.ana, joinedAt: now },
      { userId: s.bia, joinedAt: later(30) },
    ]);
    expect(
      (await conversations.findById(asAna, s.conversationId))
        ?.participantUserIds,
    ).toEqual([s.ana, s.bia].sort());
  });

  it('participant_user_ids is derived: a direct write is refused', async () => {
    const s = await seed();
    await expect(
      asApp(
        { organizationId: s.orgA, userId: s.ana },
        `UPDATE conversations SET participant_user_ids = ARRAY[$1::uuid, $2::uuid] WHERE id = $3`,
        [s.ana, s.caio, s.conversationId],
      ),
    ).rejects.toSatisfy((e) => pgCode(e) === '23514');
  });

  it('the executor Hub creates a conversation in the name of its owner; the old executor loses access when replaced', async () => {
    const s = await seed();
    const asHub = hubScope(s.orgA, s.hub);
    const notice = Conversation.create({
      id: newId(),
      organizationId: s.orgA,
      spaceId: s.space,
      createdByUserId: s.ana,
      ownerUserId: s.ana,
      executorHubId: s.hub,
      state: 'aviso',
      encryptedHeader: blob(60),
      now,
    });
    await conversations.create(asHub, notice);
    const seenByAna = await conversations.findById(
      userScope(s.orgA, s.ana),
      notice.id,
    );
    expect(seenByAna?.participantUserIds).toEqual([s.ana]);
    expect(seenByAna?.state).toBe('aviso');

    // Trocar o executor (pela dona): o Hub antigo deixa de ver a conversa e o que é dela.
    await uow.run(async () => {
      const c = await conversations.lockById(
        userScope(s.orgA, s.ana),
        notice.id,
      );
      c!.changeExecutor(null);
      await conversations.save(userScope(s.orgA, s.ana), c!);
    });
    expect(await conversations.findById(asHub, notice.id)).toBeNull();
    expect(
      (await conversations.findById(userScope(s.orgA, s.ana), notice.id))
        ?.keyRotationRequired,
    ).toBe(true);
    expect(await conversations.idsWithExecutor(asHub, s.hub)).toEqual([
      s.conversationId,
    ]);
  });

  it('messages: resending the same id does not duplicate; ack and the inbox', async () => {
    const s = await seed();
    const asAna = userScope(s.orgA, s.ana);
    const asHub = hubScope(s.orgA, s.hub);
    expect(await messages.insertIfAbsent(asAna, s.fromAna)).toBe(false);
    expect(
      (await messages.listPending(asHub, s.conversationId)).map((m) => m.id),
    ).toEqual([s.fromAna.id]);
    const m = (await messages.findById(asHub, s.fromAna.id))!;
    expect(m.isSameSubmission(s.fromAna)).toBe(true);
    m.ack(later(50));
    await messages.save(asHub, m);
    expect(await messages.listPending(asHub, s.conversationId)).toEqual([]);
    expect((await messages.findById(asAna, s.fromAna.id))?.ackedAt).toEqual(
      later(50),
    );
  });

  it('the database enforces the shapes: one author, one recipient, state list, sizes, same-conversation references', async () => {
    const s = await seed();
    const ctx = { organizationId: s.orgA, userId: s.ana };
    const reject = async (sql: string, params: unknown[], code = '23514') =>
      expect(asApp(ctx, sql, params)).rejects.toSatisfy(
        (e) => pgCode(e) === code,
      );

    await reject(`UPDATE conversations SET state = 'feito' WHERE id = $1`, [
      s.conversationId,
    ]);
    await reject(
      `INSERT INTO conversation_key_grants (organization_id, conversation_id, key_version, user_id, hub_id, wrapped_key)
       VALUES ($1, $2, 2, $3, $4, $5)`,
      [s.orgA, s.conversationId, s.ana, s.hub, wrapped(4)],
    );
    await reject(
      `INSERT INTO conversation_key_grants (organization_id, conversation_id, key_version, user_id, wrapped_key)
       VALUES ($1, $2, 2, $3, 'short')`,
      [s.orgA, s.conversationId, s.ana],
    );
    // Mensagem do Hub nasce confirmada; corpo e tamanho batem.
    await reject(
      `INSERT INTO conversation_messages (id, organization_id, conversation_id, author_hub_id, key_version, encrypted_body, body_bytes, pending, sent_at)
       VALUES ($1, $2, $3, $4, 1, $5, 100, true, now())`,
      [newId(), s.orgA, s.conversationId, s.hub, blob(100)],
    );
    await reject(
      `INSERT INTO conversation_messages (id, organization_id, conversation_id, author_user_id, key_version, encrypted_body, body_bytes, pending, sent_at)
       VALUES ($1, $2, $3, $4, 1, $5, 99, true, now())`,
      [newId(), s.orgA, s.conversationId, s.ana, blob(100)],
    );
    await reject(
      `INSERT INTO conversation_attachments (id, organization_id, conversation_id, key_version, size_bytes, sha256, upload_expires_at)
       VALUES ($1, $2, $3, 1, 104857601, $4, now())`,
      [newId(), s.orgA, s.conversationId, 'c'.repeat(64)],
    );
    // A mensagem do anexo tem de ser da mesma conversa (FK composta).
    const other = Conversation.create({
      id: newId(),
      organizationId: s.orgA,
      spaceId: s.space,
      createdByUserId: s.ana,
      ownerUserId: s.ana,
      executorHubId: null,
      state: 'na_fila',
      encryptedHeader: blob(60),
      now,
    });
    await conversations.create(userScope(s.orgA, s.ana), other);
    await reject(
      `INSERT INTO conversation_attachments (id, organization_id, conversation_id, message_id, key_version, size_bytes, sha256, upload_expires_at)
       VALUES ($1, $2, $3, $4, 1, 10, $5, now())`,
      [newId(), s.orgA, other.id, s.fromAna.id, 'c'.repeat(64)],
      '23503',
    );
  });

  it('a Hub that stops being the executor is cleared in a participant`s context, never in its own (42501)', async () => {
    const s = await seed();
    const asHub = hubScope(s.orgA, s.hub);
    const asAna = userScope(s.orgA, s.ana);

    // No contexto do próprio Hub: a linha nova (executor nulo) não passa pela policy de SELECT dele.
    const seenByHub = (await conversations.findById(asHub, s.conversationId))!;
    expect(seenByHub.loseExecutor()).toBe(true);
    await expect(conversations.save(asHub, seenByHub)).rejects.toSatisfy(
      (e) => pgCode(e) === '42501',
    );
    expect(
      (await conversations.findById(asAna, s.conversationId))?.executorHubId,
    ).toBe(s.hub);

    // No contexto de um participante (a dona do Hub): passa, e o Hub perde tudo menos a própria cópia com lápide.
    await uow.run(async () => {
      const c = (await conversations.lockById(asAna, s.conversationId))!;
      expect(c.loseExecutor()).toBe(true);
      await conversations.save(asAna, c);
      expect(
        await grants.removeFor(asAna, s.conversationId, {
          kind: 'hub',
          hubId: s.hub,
        }),
      ).toBe(1);
    });
    const after = await conversations.findById(asAna, s.conversationId);
    expect(after?.executorHubId).toBeNull();
    expect(after?.keyRotationRequired).toBe(true);
    expect(
      await visibleCounts({ organizationId: s.orgA, hubId: s.hub }),
    ).toEqual({
      conversations: 0,
      conversation_participants: 0,
      conversation_key_grants: 1,
      conversation_messages: 0,
      conversation_attachments: 0,
    });
  });

  it('the identity columns of the rows never change (a participation cannot move to another conversation)', async () => {
    const s = await seed();
    const ctx = { organizationId: s.orgA, userId: s.ana };
    const other = Conversation.create({
      id: newId(),
      organizationId: s.orgA,
      spaceId: s.space,
      createdByUserId: s.ana,
      ownerUserId: s.ana,
      executorHubId: null,
      state: 'na_fila',
      encryptedHeader: blob(60),
      now,
    });
    await conversations.create(userScope(s.orgA, s.ana), other);
    const refuse = (sql: string, params: unknown[]) =>
      expect(asApp(ctx, sql, params)).rejects.toSatisfy(
        (e) => pgCode(e) === '23514',
      );

    await refuse(
      `UPDATE conversation_participants SET conversation_id = $1 WHERE conversation_id = $2 AND user_id = $3`,
      [other.id, s.conversationId, s.bia],
    );
    await refuse(
      `UPDATE conversation_participants SET user_id = $1 WHERE conversation_id = $2 AND user_id = $3`,
      [s.caio, s.conversationId, s.bia],
    );
    await refuse(
      `UPDATE conversation_key_grants SET conversation_id = $1 WHERE conversation_id = $2`,
      [other.id, s.conversationId],
    );
    await refuse(
      `UPDATE conversation_key_grants SET user_id = $1 WHERE conversation_id = $2 AND user_id = $3`,
      [s.caio, s.conversationId, s.bia],
    );
    await refuse(
      `UPDATE conversation_messages SET conversation_id = $1 WHERE id = $2`,
      [other.id, s.fromAna.id],
    );
    await refuse(
      `UPDATE conversation_attachments SET key_version = 2 WHERE id = $1`,
      [s.attachment.id],
    );
    const space2 = Space.create({ organizationId: s.orgA, name: 'Outro', now });
    await spaces.create(space2);
    await refuse(`UPDATE conversations SET space_id = $1 WHERE id = $2`, [
      space2.id,
      s.conversationId,
    ]);
    // O resto continua gravável (tombstone, ack...).
    expect(
      await participants.remove(userScope(s.orgA, s.ana), other.id, s.ana),
    ).toBe(true);
  });

  it('the header is null only after the tombstone (retention)', async () => {
    const s = await seed();
    const ctx = { organizationId: s.orgA, userId: s.ana };
    await expect(
      asApp(
        ctx,
        `UPDATE conversations SET encrypted_header = NULL, header_key_version = NULL WHERE id = $1`,
        [s.conversationId],
      ),
    ).rejects.toSatisfy((e) => pgCode(e) === '23514');
    const raw = await asApp(
      ctx,
      `UPDATE conversations SET deleted_at = now(), encrypted_header = NULL, header_key_version = NULL WHERE id = $1`,
      [s.conversationId],
    );
    expect(updatedCount(raw)).toBe(1);
  });

  it('lockById requires a unit of work', async () => {
    const s = await seed();
    await expect(
      conversations.lockById(userScope(s.orgA, s.ana), s.conversationId),
    ).rejects.toThrow(/active unit of work/);
  });
});
