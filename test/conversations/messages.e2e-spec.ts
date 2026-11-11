import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Response } from 'supertest';
import { newId } from '../../src/shared/domain/id.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import {
  newConversationKey,
  openMessage,
} from '../support/conversation-crypto.js';
import {
  conversationRow,
  conversationSpaceUsage,
  conversationsKit,
  hubRecipientOf,
  lastMessageAt,
  liveGrants,
  messageRows,
  type ConversationKeys,
} from '../support/conversations-kit.js';
import { hubClient } from '../support/hub-client.js';
import { hubsKit, type ClaimedHub } from '../support/hubs-kit.js';
import {
  expectStatus,
  identityClient,
  recipientOf,
  type KeyedUser,
} from '../support/identity-client.js';

function expectProblem(
  res: Response,
  status: number,
  type: string,
): Record<string, unknown> {
  if (res.status !== status || !String(res.body.type).endsWith(`/${type}`)) {
    throw new Error(
      `expected ${status} ${type}, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }
  expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  return res.body as Record<string, unknown>;
}

const GiB = 1024 ** 3;

// Mensagens e caixa de entrada (spec conversations §4.3, §4.4.1) pela HTTP real, com a cifra real do cliente e do Hub
// e o papel de runtime (RLS valendo). Review Focus 2 (reenvio idempotente) e 3 (versão velha depois de alguém sair).
describe('conversation messages (e2e)', () => {
  let app: INestApplication;
  const c = identityClient(() => app);
  const s = c.spaces;
  const h = hubClient(() => app);
  const hubs = hubsKit(() => app);
  const k = conversationsKit(() => app);

  let olivia: KeyedUser; // admin, Gestora do espaço, dona do Hub "casa"
  let ana: KeyedUser; // editora do espaço
  let bruno: KeyedUser; // leitor do espaço
  let paulo: KeyedUser; // editor do espaço, dono do Hub "paulo"
  let orgId: string;
  let kitPublicKey: string;
  let spaceId: string;
  let casa: ClaimedHub; // Hub da Olivia, com o espaço instalado
  let pauloHub: ClaimedHub; // Hub do Paulo, com o espaço instalado

  const token = (hub: ClaimedHub) => h.authenticate(hub);
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  /** Olivia's conversation with her hub as executor, shared with `others`. */
  const conversation = async (others: KeyedUser[] = [], sp = spaceId) => {
    const conv = await k.create(olivia, sp, {
      executor: hubRecipientOf(casa),
    });
    await expectStatus(Promise.resolve(conv.res), 201);
    if (others.length) {
      await expectStatus(
        k.share(olivia, sp, conv.id, others.map(recipientOf), conv.keys),
        200,
      );
    }
    return { id: conv.id, keys: conv.keys as ConversationKeys };
  };

  const spaceStorage = async (user: KeyedUser, sp: string) =>
    (
      await expectStatus(
        request(app.getHttpServer())
          .get(`/spaces/${sp}`)
          .set(bearer(user.token)),
        200,
      )
    ).body.storage as {
      quotaBytes: number;
      usedBytes: number;
      trashBytes: number;
    };

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    olivia = await s.signUpKeyed('olivia@example.com', 'Olivia');
    ana = await s.signUpKeyed('ana@example.com', 'Ana');
    bruno = await s.signUpKeyed('bruno@example.com', 'Bruno');
    paulo = await s.signUpKeyed('paulo@example.com', 'Paulo');
    const o = await s.orgWithKit(olivia, 'Casa');
    orgId = o.orgId;
    kitPublicKey = o.kit.publicKey;
    for (const u of [ana, bruno, paulo]) await s.joinOrg(olivia, orgId, u);

    casa = await h.onboard(olivia.token, 'Casa');
    pauloHub = await h.onboard(paulo.token, 'Paulo');
    await hubs.link(olivia, casa.hubId, orgId);
    const pl = await hubs.link(paulo, pauloHub.hubId, orgId);
    if (pl.status !== 'approved') {
      await hubs.approve(olivia, pauloHub.hubId, orgId);
    }
    const sp = await s.create(olivia, orgId, kitPublicKey, 'Projetos', {
      storageQuotaBytes: GiB,
    });
    await expectStatus(Promise.resolve(sp.res), 201);
    spaceId = sp.spaceId;
    for (const [u, role] of [
      [ana, 'space_editor'],
      [bruno, 'space_reader'],
      [paulo, 'space_editor'],
    ] as const) {
      await expectStatus(
        s.addMember(olivia.token, spaceId, recipientOf(u), [sp.key], role),
        201,
      );
    }
    await hubs.addSpace(olivia, casa.hubId, spaceId);
    await hubs.addSpace(paulo, pauloHub.hubId, spaceId);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  });

  describe('send', () => {
    it('a person sends: pending, last message at, the body opens with the key; a resend is the same answer (Review Focus 2)', async () => {
      const conv = await conversation([bruno]);
      const before = await conversationSpaceUsage(spaceId);
      const sent = await k.send(olivia, spaceId, conv.id, conv.keys, {
        text: 'liga a luz da sala',
      });
      const created = await expectStatus(Promise.resolve(sent.res), 201);
      expect(created.body).toEqual({
        id: sent.id,
        conversationId: conv.id,
        authorUserId: olivia.userId,
        authorHubId: null,
        authorCloud: false,
        keyVersion: 1,
        bodyBytes: Buffer.from(sent.body.encryptedBody, 'base64url').length,
        replacesMessageId: null,
        pending: true,
        ackedAt: null,
        sentAt: expect.any(String),
        deletedAt: null,
      });
      expect((await lastMessageAt(conv.id))?.toISOString()).toBe(
        created.body.sentAt,
      );

      // Network failure on the way back: the app resends the same thing. One row, the same answer.
      const again = await expectStatus(
        k.sendRaw(olivia, spaceId, conv.id, sent.body),
        200,
      );
      expect(again.body).toEqual(created.body);
      const rows = await messageRows(conv.id);
      expect(rows).toHaveLength(1);
      expect(
        new TextDecoder().decode(
          await openMessage(
            conv.keys[0]!,
            {
              spaceId,
              conversationId: conv.id,
              recordId: sent.id,
              keyVersion: 1,
            },
            Buffer.from(rows[0]!.encrypted_body!, 'base64url'),
          ),
        ),
      ).toBe('liga a luz da sala');

      // The message bytes count in the space usage, once.
      expect(await conversationSpaceUsage(spaceId)).toEqual({
        bodyBytes: before.bodyBytes + created.body.bodyBytes,
        trashBytes: before.trashBytes,
      });

      // The same id with another content: 409, nothing changes.
      const other = await k.send(olivia, spaceId, conv.id, conv.keys, {
        id: sent.id,
        text: 'outra coisa',
      });
      expectProblem(other.res, 409, 'message-id-conflict');
      // And from another participant, with the very same body.
      expectProblem(
        await k.sendRaw(bruno, spaceId, conv.id, sent.body),
        409,
        'message-id-conflict',
      );
      expect(await messageRows(conv.id)).toHaveLength(1);
    });

    it('an id already used in a conversation the sender cannot see is 409 message-id-conflict, never "already sent"', async () => {
      const anas = await k.create(ana, spaceId);
      await expectStatus(Promise.resolve(anas.res), 201);
      const hers = await k.send(ana, spaceId, anas.id, anas.keys);
      await expectStatus(Promise.resolve(hers.res), 201);

      const mine = await conversation();
      const reused = await k.send(olivia, spaceId, mine.id, mine.keys, {
        id: hers.id,
      });
      expectProblem(reused.res, 409, 'message-id-conflict');
      expect(await messageRows(mine.id)).toHaveLength(0);
      expect(await lastMessageAt(mine.id)).toBeNull();
    });

    it('a member of the space who does not participate gets 404 conversation-not-found', async () => {
      const conv = await conversation();
      const res = await k.send(bruno, spaceId, conv.id, conv.keys);
      expectProblem(res.res, 404, 'conversation-not-found');
      expect(await messageRows(conv.id)).toHaveLength(0);
    });

    it('a malformed or too large body: 422', async () => {
      const conv = await conversation();
      expectProblem(
        await k.sendRaw(olivia, spaceId, conv.id, {
          id: newId(),
          keyVersion: 1,
          encryptedBody: Buffer.alloc(10, 1).toString('base64url'),
        }),
        422,
        'encrypted-blob-invalid',
      );
      const big = Buffer.alloc(65_537, 0xab);
      big[0] = 0x01;
      expectProblem(
        await k.sendRaw(olivia, spaceId, conv.id, {
          id: newId(),
          keyVersion: 1,
          encryptedBody: big.toString('base64url'),
        }),
        422,
        'message-too-large',
      );
    });
  });

  describe('a participant leaves mid-way (Review Focus 3)', () => {
    it('the old version is refused (409) and nothing is written; after the rotation only the active hold the new version', async () => {
      const conv = await conversation([ana, bruno]);
      await expectStatus(k.leave(ana, spaceId, conv.id), 204);

      // Ana's app still tries with the old key: she is out.
      const fromAna = await k.send(ana, spaceId, conv.id, conv.keys);
      expectProblem(fromAna.res, 404, 'conversation-not-found');
      // Bruno, still inside, with v1 while the rotation is pending.
      const pending = await k.send(bruno, spaceId, conv.id, conv.keys);
      expectProblem(pending.res, 409, 'conversation-key-rotation-required');
      // The executor too.
      const hubPending = await k.hubSend(
        await token(casa),
        spaceId,
        conv.id,
        conv.keys,
      );
      expectProblem(hubPending.res, 409, 'conversation-key-rotation-required');
      expect(await messageRows(conv.id)).toHaveLength(0);
      expect(await lastMessageAt(conv.id)).toBeNull();

      const v2 = await newConversationKey();
      await expectStatus(
        k.rotate(
          bruno,
          spaceId,
          conv.id,
          await k.rotationBody(2, v2, [olivia, bruno].map(recipientOf), [
            hubRecipientOf(casa),
          ]),
        ),
        200,
      );
      const keys = [...conv.keys, v2];

      const stale = await k.send(bruno, spaceId, conv.id, keys, {
        keyVersion: 1,
      });
      expect(
        expectProblem(stale.res, 409, 'conversation-key-version-stale'),
      ).toMatchObject({ expectedVersion: 2 });
      const ok = await k.send(bruno, spaceId, conv.id, keys);
      expect(
        (await expectStatus(Promise.resolve(ok.res), 201)).body,
      ).toMatchObject({ keyVersion: 2, pending: true });
      const v2Holders = (await liveGrants(conv.id))
        .filter(([v]) => v === 2)
        .map(([, w]) => w)
        .sort();
      expect(v2Holders).toEqual(
        [olivia.userId, bruno.userId, casa.hubId].sort(),
      );
      expect(await messageRows(conv.id)).toHaveLength(1);
    });
  });

  describe('inbox', () => {
    it("the executor acknowledges a person's message; its own messages are born acknowledged", async () => {
      const conv = await conversation();
      const sent = await k.send(olivia, spaceId, conv.id, conv.keys);
      await expectStatus(Promise.resolve(sent.res), 201);
      const t = await token(casa);

      const acked = await expectStatus(k.hubAck(t, conv.id, sent.id), 200);
      expect(acked.body).toMatchObject({
        id: sent.id,
        pending: false,
        ackedAt: expect.any(String),
      });
      // Acknowledging again: the first ack stays.
      const again = await expectStatus(k.hubAck(t, conv.id, sent.id), 200);
      expect(again.body.ackedAt).toBe(acked.body.ackedAt);

      const reply = await k.hubSend(t, spaceId, conv.id, conv.keys, {
        text: 'luz ligada',
      });
      const replied = await expectStatus(Promise.resolve(reply.res), 201);
      expect(replied.body).toMatchObject({
        authorHubId: casa.hubId,
        authorUserId: null,
        pending: false,
        ackedAt: replied.body.sentAt,
      });
      // The hub resends the same reply: the same answer.
      const resent = await expectStatus(
        request(app.getHttpServer())
          .post(`/hub/conversations/${conv.id}/messages`)
          .set(bearer(t))
          .send(reply.body),
        200,
      );
      expect(resent.body).toEqual(replied.body);
      const rows = await messageRows(conv.id);
      expect(rows.map((r) => [r.id, r.pending])).toEqual([
        [sent.id, false],
        [reply.id, false],
      ]);
      expect(
        new TextDecoder().decode(
          await openMessage(
            conv.keys[0]!,
            {
              spaceId,
              conversationId: conv.id,
              recordId: reply.id,
              keyVersion: 1,
            },
            Buffer.from(rows[1]!.encrypted_body!, 'base64url'),
          ),
        ),
      ).toBe('luz ligada');
    });

    it('only the executor acknowledges: another hub gets 404; an unknown message is 404 message-not-found', async () => {
      const conv = await conversation();
      const sent = await k.send(olivia, spaceId, conv.id, conv.keys);
      await expectStatus(Promise.resolve(sent.res), 201);
      expectProblem(
        await k.hubAck(await token(pauloHub), conv.id, sent.id),
        404,
        'conversation-not-found',
      );
      expectProblem(
        await k.hubAck(await token(casa), conv.id, newId()),
        404,
        'message-not-found',
      );
      expect((await messageRows(conv.id))[0]!.pending).toBe(true);
      // Another hub cannot send there either.
      const intruder = await k.hubSend(
        await token(pauloHub),
        spaceId,
        conv.id,
        conv.keys,
      );
      expectProblem(intruder.res, 404, 'conversation-not-found');
    });

    it("a send and an ack do not wait for an attachment confirmation's FOR KEY SHARE; a key rotation's FOR UPDATE would", async () => {
      const conv = await conversation();
      const first = await k.send(olivia, spaceId, conv.id, conv.keys);
      await expectStatus(Promise.resolve(first.res), 201);
      const t = await token(casa);
      // What a confirmation holds on the conversation during its S3 copy.
      const holder = (await adminDataSource()).createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      try {
        await holder.query(
          `SELECT 1 FROM conversations WHERE id = $1 FOR KEY SHARE`,
          [conv.id],
        );
        const within = <T>(p: Promise<T>) =>
          Promise.race([
            p,
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error('waited for FOR KEY SHARE')),
                5_000,
              ),
            ),
          ]);
        const sent = await within(k.send(olivia, spaceId, conv.id, conv.keys));
        await expectStatus(Promise.resolve(sent.res), 201);
        await expectStatus(within(k.hubAck(t, conv.id, first.id)), 200);
        // A rotation-style lock (FOR UPDATE) conflicts with it.
        const other = (await adminDataSource()).createQueryRunner();
        await other.connect();
        try {
          await other.startTransaction();
          await other.query(`SET LOCAL lock_timeout = '200ms'`);
          await expect(
            other.query(
              `SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE`,
              [conv.id],
            ),
          ).rejects.toMatchObject({ driverError: { code: '55P03' } });
          await other.rollbackTransaction();
        } finally {
          await other.release();
        }
      } finally {
        await holder.rollbackTransaction();
        await holder.release();
      }
    }, 20_000);

    it('executor changed: what the old hub acknowledged and never answered goes back to pending, and the new hub sees it as work', async () => {
      const conv = await conversation([paulo]);
      const casaToken = await token(casa);
      const answered = await k.send(olivia, spaceId, conv.id, conv.keys, {
        text: 'primeira',
      });
      await expectStatus(Promise.resolve(answered.res), 201);
      await expectStatus(k.hubAck(casaToken, conv.id, answered.id), 200);
      const reply = await k.hubSend(casaToken, spaceId, conv.id, conv.keys, {
        text: 'feito',
      });
      await expectStatus(Promise.resolve(reply.res), 201);
      const taken = await k.send(olivia, spaceId, conv.id, conv.keys, {
        text: 'segunda',
      });
      await expectStatus(Promise.resolve(taken.res), 201);
      await expectStatus(k.hubAck(casaToken, conv.id, taken.id), 200);
      expect(
        (await messageRows(conv.id)).map((r) => [r.id, r.pending]),
      ).toEqual([
        [answered.id, false],
        [reply.id, false],
        [taken.id, false],
      ]);

      await expectStatus(
        k.changeExecutor(
          olivia,
          spaceId,
          conv.id,
          hubRecipientOf(pauloHub),
          conv.keys,
        ),
        200,
      );
      const rows = await messageRows(conv.id);
      expect(rows.map((r) => [r.id, r.pending, r.acked_at === null])).toEqual([
        [answered.id, false, false],
        [reply.id, false, false],
        [taken.id, true, true],
      ]);
      // The new executor backfills the conversation and finds the message as work (pending), never lost.
      const pauloToken = await token(pauloHub);
      const page = await expectStatus(
        request(app.getHttpServer())
          .get('/hub/conversations/changes')
          .query({ conversationId: conv.id, since: 0 })
          .set(bearer(pauloToken)),
        200,
      );
      const item = (
        page.body.items as { type: string; data: Record<string, unknown> }[]
      ).find(
        (i) => i.type === 'conversation_message' && i.data.id === taken.id,
      );
      expect(item?.data).toMatchObject({ pending: true, ackedAt: null });
      // The old hub can no longer ack it (404: not the executor); the new one can.
      expectProblem(
        await k.hubAck(casaToken, conv.id, taken.id),
        404,
        'conversation-not-found',
      );
      await expectStatus(
        k.hubAck(await token(pauloHub), conv.id, taken.id),
        200,
      );
    });

    it('executor lost (space removed from the hub): what it acknowledged without answering goes back to pending', async () => {
      const sp = await s.create(olivia, orgId, kitPublicKey, 'Caixa', {
        storageQuotaBytes: GiB,
      });
      await expectStatus(Promise.resolve(sp.res), 201);
      await hubs.addSpace(olivia, casa.hubId, sp.spaceId);
      const conv = await conversation([], sp.spaceId);
      const sent = await k.send(olivia, sp.spaceId, conv.id, conv.keys);
      await expectStatus(Promise.resolve(sent.res), 201);
      await expectStatus(k.hubAck(await token(casa), conv.id, sent.id), 200);

      await hubs.removeSpace(olivia, casa.hubId, sp.spaceId);
      expect(await conversationRow(conv.id)).toMatchObject({
        executor_hub_id: null,
      });
      expect((await messageRows(conv.id))[0]).toMatchObject({
        pending: true,
        acked_at: null,
      });
    });

    it('the owner of the executor hub leaves the conversation: the executor goes and its unanswered acks go back to pending', async () => {
      // Paulo's hub executes Olivia's conversation (Paulo participates); Paulo leaves.
      const created = await k.create(olivia, spaceId);
      await expectStatus(Promise.resolve(created.res), 201);
      const conv = { id: created.id, keys: created.keys as ConversationKeys };
      await expectStatus(
        k.share(olivia, spaceId, conv.id, [recipientOf(paulo)], conv.keys),
        200,
      );
      await expectStatus(
        k.changeExecutor(
          olivia,
          spaceId,
          conv.id,
          hubRecipientOf(pauloHub),
          conv.keys,
        ),
        200,
      );
      const sent = await k.send(olivia, spaceId, conv.id, conv.keys);
      await expectStatus(Promise.resolve(sent.res), 201);
      await expectStatus(
        k.hubAck(await token(pauloHub), conv.id, sent.id),
        200,
      );
      await expectStatus(k.leave(paulo, spaceId, conv.id), 204);
      expect(await conversationRow(conv.id)).toMatchObject({
        executor_hub_id: null,
      });
      expect((await messageRows(conv.id))[0]).toMatchObject({
        pending: true,
        acked_at: null,
      });
    });

    it("without an executor the person's messages wait as pending", async () => {
      const conv = await k.create(olivia, spaceId);
      await expectStatus(Promise.resolve(conv.res), 201);
      const sent = await k.send(olivia, spaceId, conv.id, conv.keys);
      expect(
        (await expectStatus(Promise.resolve(sent.res), 201)).body.pending,
      ).toBe(true);
      expect(await conversationRow(conv.id)).toMatchObject({
        executor_hub_id: null,
      });
    });
  });

  describe('delete and edit', () => {
    it("each one deletes only their own: someone else's is 403; the bytes move to the trash part of the usage", async () => {
      const conv = await conversation([bruno]);
      const sent = await k.send(olivia, spaceId, conv.id, conv.keys);
      const bytes = (await expectStatus(Promise.resolve(sent.res), 201)).body
        .bodyBytes as number;
      expectProblem(
        await k.deleteMessage(bruno, spaceId, conv.id, sent.id),
        403,
        'not-conversation-owner',
      );
      expectProblem(
        await k.hubDeleteMessage(await token(casa), conv.id, sent.id),
        403,
        'not-conversation-owner',
      );
      const usageBefore = await conversationSpaceUsage(spaceId);
      const storageBefore = await spaceStorage(olivia, spaceId);
      await expectStatus(
        k.deleteMessage(olivia, spaceId, conv.id, sent.id),
        204,
      );
      // Idempotent.
      await expectStatus(
        k.deleteMessage(olivia, spaceId, conv.id, sent.id),
        204,
      );
      const [row] = await messageRows(conv.id);
      expect(row).toMatchObject({ deleted: true });
      expect(row!.encrypted_body).not.toBeNull(); // kept 30 days (retention)
      expect(await conversationSpaceUsage(spaceId)).toEqual({
        bodyBytes: usageBefore.bodyBytes,
        trashBytes: usageBefore.trashBytes + bytes,
      });
      const storageAfter = await spaceStorage(olivia, spaceId);
      expect(storageAfter.usedBytes).toBe(storageBefore.usedBytes);
      expect(storageAfter.trashBytes).toBe(storageBefore.trashBytes + bytes);
      expectProblem(
        await k.deleteMessage(olivia, spaceId, conv.id, newId()),
        404,
        'message-not-found',
      );
    });

    it('the executor deletes its own message', async () => {
      const conv = await conversation();
      const t = await token(casa);
      const reply = await k.hubSend(t, spaceId, conv.id, conv.keys);
      await expectStatus(Promise.resolve(reply.res), 201);
      await expectStatus(k.hubDeleteMessage(t, conv.id, reply.id), 204);
      expect((await messageRows(conv.id))[0]).toMatchObject({ deleted: true });
    });

    it('edit = a new message that replaces mine; the previous one becomes a tombstone', async () => {
      const conv = await conversation([bruno]);
      const first = await k.send(olivia, spaceId, conv.id, conv.keys, {
        text: 'liga a luz',
      });
      await expectStatus(Promise.resolve(first.res), 201);
      const edit = await k.send(olivia, spaceId, conv.id, conv.keys, {
        text: 'liga a luz da cozinha',
        replacesMessageId: first.id,
      });
      expect(
        (await expectStatus(Promise.resolve(edit.res), 201)).body,
      ).toMatchObject({ replacesMessageId: first.id, pending: true });
      expect(
        (await messageRows(conv.id)).map((r) => [
          r.id,
          r.replaces_message_id,
          r.deleted,
        ]),
      ).toEqual([
        [first.id, null, true],
        [edit.id, first.id, false],
      ]);
      // Resending the edit is idempotent even though the original is a tombstone now.
      await expectStatus(k.sendRaw(olivia, spaceId, conv.id, edit.body), 200);
      // Someone else's message cannot be edited; a deleted one neither.
      const byBruno = await k.send(bruno, spaceId, conv.id, conv.keys, {
        replacesMessageId: edit.id,
      });
      expectProblem(byBruno.res, 403, 'not-conversation-owner');
      const again = await k.send(olivia, spaceId, conv.id, conv.keys, {
        replacesMessageId: first.id,
      });
      expectProblem(again.res, 422, 'message-replaces-invalid');
      expect(await messageRows(conv.id)).toHaveLength(2);
    });
  });

  describe('header', () => {
    const bytesOf = (b64: string) => Buffer.from(b64, 'base64url').length;

    it('the owner replaces the header (current key version); the bytes move the space usage; others: 403/404', async () => {
      const conv = await conversation([ana]);
      const before = await expectStatus(k.get(olivia, spaceId, conv.id), 200);
      const oldBytes = bytesOf(before.body.encryptedHeader as string);
      const usage = (await conversationSpaceUsage(spaceId)).bodyBytes;

      const replaced = await k.replaceHeader(
        olivia,
        spaceId,
        conv.id,
        conv.keys,
        {
          title: 'Um titulo bem mais comprido para o assunto',
        },
      );
      const res = await expectStatus(Promise.resolve(replaced.res), 200);
      expect(res.body).toMatchObject({
        id: conv.id,
        encryptedHeader: replaced.encryptedHeader,
      });
      expect((await conversationSpaceUsage(spaceId)).bodyBytes).toBe(
        usage - oldBytes + bytesOf(replaced.encryptedHeader),
      );

      // Another participant: 403; a member of the space who does not participate: 404.
      expectProblem(
        (await k.replaceHeader(ana, spaceId, conv.id, conv.keys)).res,
        403,
        'not-conversation-owner',
      );
      expectProblem(
        (await k.replaceHeader(bruno, spaceId, conv.id, conv.keys)).res,
        404,
        'conversation-not-found',
      );
      // A version that is not the current one: 409.
      expectProblem(
        (
          await k.replaceHeader(olivia, spaceId, conv.id, conv.keys, {
            keyVersion: 2,
          })
        ).res,
        409,
        'conversation-key-version-stale',
      );
    });

    it('a pending key rotation refuses the header (409); the executor replaces it, another hub gets 404', async () => {
      const conv = await conversation([ana]);
      const casaToken = await token(casa);
      const byHub = await k.hubReplaceHeader(
        casaToken,
        spaceId,
        conv.id,
        conv.keys,
        { title: 'Plano do copiloto' },
      );
      expect(
        (await expectStatus(Promise.resolve(byHub.res), 200)).body
          .encryptedHeader,
      ).toBe(byHub.encryptedHeader);
      expectProblem(
        (
          await k.hubReplaceHeader(
            await token(pauloHub),
            spaceId,
            conv.id,
            conv.keys,
          )
        ).res,
        404,
        'conversation-not-found',
      );

      await expectStatus(k.leave(ana, spaceId, conv.id), 204);
      expectProblem(
        (await k.replaceHeader(olivia, spaceId, conv.id, conv.keys)).res,
        409,
        'conversation-key-rotation-required',
      );
      expectProblem(
        (await k.hubReplaceHeader(casaToken, spaceId, conv.id, conv.keys)).res,
        409,
        'conversation-key-rotation-required',
      );
    });

    it('creating counts the header in the usage; a full space refuses a bigger header and a new conversation (422)', async () => {
      const sp = await s.create(olivia, orgId, kitPublicKey, 'Cabecalhos', {
        storageQuotaBytes: GiB,
      });
      await expectStatus(Promise.resolve(sp.res), 201);
      const created = await k.create(olivia, sp.spaceId);
      await expectStatus(Promise.resolve(created.res), 201);
      const headerBytes = bytesOf(
        (await expectStatus(k.get(olivia, sp.spaceId, created.id), 200)).body
          .encryptedHeader as string,
      );
      expect(await conversationSpaceUsage(sp.spaceId)).toMatchObject({
        bodyBytes: headerBytes,
      });
      expect((await spaceStorage(olivia, sp.spaceId)).usedBytes).toBe(
        headerBytes,
      );

      // Pretend the rest of the space is full: exactly at the quota.
      const admin = await adminDataSource();
      await admin.query(
        `UPDATE conversation_space_usage SET body_bytes = $2 WHERE space_id = $1`,
        [sp.spaceId, GiB],
      );
      const bigger = await k.replaceHeader(
        olivia,
        sp.spaceId,
        created.id,
        created.keys,
        { title: 'x'.repeat(200) },
      );
      expect(
        expectProblem(bigger.res, 422, 'space-storage-full').missingBytes,
      ).toBe(bytesOf(bigger.encryptedHeader) - headerBytes);
      expect(await conversationSpaceUsage(sp.spaceId)).toMatchObject({
        bodyBytes: GiB,
      });
      expectProblem(
        (await k.create(olivia, sp.spaceId)).res,
        422,
        'space-storage-full',
      );
    });
  });

  describe('space usage', () => {
    it('a full space refuses the message (422 space-storage-full) and the backup intent counts message bytes too', async () => {
      const sp = await s.create(olivia, orgId, kitPublicKey, 'Cheio', {
        storageQuotaBytes: GiB,
      });
      await expectStatus(Promise.resolve(sp.res), 201);
      await hubs.addSpace(olivia, casa.hubId, sp.spaceId);
      const conv = await conversation([], sp.spaceId);
      const first = await k.send(olivia, sp.spaceId, conv.id, conv.keys);
      const bytes = (await expectStatus(Promise.resolve(first.res), 201)).body
        .bodyBytes as number;
      // The conversation's header counts too (ConversationHeaderUsage).
      const headerBytes = Buffer.from(
        (await expectStatus(k.get(olivia, sp.spaceId, conv.id), 200)).body
          .encryptedHeader as string,
        'base64url',
      ).length;
      expect((await spaceStorage(olivia, sp.spaceId)).usedBytes).toBe(
        bytes + headerBytes,
      );

      // The rest of the space is (pretend) full: only 10 bytes left.
      const admin = await adminDataSource();
      await admin.query(
        `UPDATE conversation_space_usage SET body_bytes = $2 WHERE space_id = $1`,
        [sp.spaceId, GiB - 10],
      );
      const refused = await k.send(olivia, sp.spaceId, conv.id, conv.keys);
      expect(
        expectProblem(refused.res, 422, 'space-storage-full'),
      ).toMatchObject({ missingBytes: bytes - 10 });
      expect(await messageRows(conv.id)).toHaveLength(1);
      expect(await conversationSpaceUsage(sp.spaceId)).toMatchObject({
        bodyBytes: GiB - 10,
      });

      // The backup sees the same usage: a 11-byte object does not fit either.
      const intent = await request(app.getHttpServer())
        .post(`/spaces/${sp.spaceId}/backup/uploads`)
        .set(bearer(olivia.token))
        .send({
          items: [
            {
              objectId: newId(),
              keyVersion: 1,
              sizeBytes: 11,
              sha256: 'a'.repeat(64),
              replacesVersionId: null,
            },
          ],
        });
      expect(expectProblem(intent, 422, 'space-storage-full')).toMatchObject({
        missingBytes: 1,
      });
    });
  });
});
