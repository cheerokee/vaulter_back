import { createHash, randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { SendMessageUseCase } from '../../src/conversations/application/send-message.use-case.js';
import { PgConversationChangeSignal } from '../../src/conversations/infra/db/pg-conversation-change-signal.js';
import { newId } from '../../src/shared/domain/id.js';
import { UnitOfWork } from '../../src/shared/infra/db/unit-of-work.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import { openMessage } from '../support/conversation-crypto.js';
import {
  conversationsKit,
  hubRecipientOf,
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

type Item = {
  type: string;
  syncVersion: number;
  deleted: boolean;
  data: Record<string, any>;
};
type Page = { organizationIds: string[]; items: Item[]; nextSince: number };

const GiB = 1024 ** 3;

// Feeds de mudanças dos assuntos (spec conversations §4.6) pela HTTP real, papel de runtime (RLS valendo):
// - pessoa: só os assuntos em que participa (Review Focus 1: membro do espaço que não participa não recebe nada,
//   nem pedindo o assunto pelo id), só as próprias cópias da chave, lápides de quem sai;
// - executor: só onde é executor, só em organização com vínculo aprovado, lápides das próprias cópias ao perder o papel;
// - sondagem longa: acorda em < 2 s com uma mensagem nova; NOTIFY perdido ainda entrega; 20 esperas em paralelo não
//   esgotam o pool (10 conexões) e as rotas normais seguem respondendo.
describe('conversation feeds (e2e)', () => {
  let app: INestApplication;
  const c = identityClient(() => app);
  const s = c.spaces;
  const h = hubClient(() => app);
  const hubs = hubsKit(() => app);
  const k = conversationsKit(() => app);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  let olivia: KeyedUser; // dona do assunto e do Hub "casa"
  let ana: KeyedUser; // participante
  let bruno: KeyedUser; // membro do espaço que NUNCA participa
  let paulo: KeyedUser; // dono do Hub "paulo"
  let orgId: string;
  let oliviaKit: string;
  let spaceId: string;
  let casa: ClaimedHub;
  let pauloHub: ClaimedHub;
  let casaToken: string;
  let pauloToken: string;

  const feed = async (user: KeyedUser, query: Record<string, unknown> = {}) =>
    (
      await expectStatus(
        http()
          .get('/conversations/changes')
          .query(query)
          .set(bearer(user.token)),
        200,
      )
    ).body as Page;

  const hubFeed = async (token: string, query: Record<string, unknown> = {}) =>
    (
      await expectStatus(
        http()
          .get('/hub/conversations/changes')
          .query(query)
          .set(bearer(token)),
        200,
      )
    ).body as Page;

  /** Every page from `since` until an empty one. */
  const drain = async (
    read: (q: Record<string, unknown>) => Promise<Page>,
    since = 0,
    extra: Record<string, unknown> = {},
  ) => {
    const items: Item[] = [];
    let cursor = since;
    for (let i = 0; i < 500; i++) {
      const page = await read({ since: cursor, ...extra });
      if (page.items.length === 0) return { items, cursor };
      items.push(...page.items);
      cursor = page.nextSince;
    }
    throw new Error('feed did not end');
  };
  const drainUser = (u: KeyedUser, since = 0, extra = {}) =>
    drain((q) => feed(u, q), since, extra);
  const drainHub = (t: string, since = 0, extra = {}) =>
    drain((q) => hubFeed(t, q), since, extra);
  const cursorOf = async (
    read: (q: Record<string, unknown>) => Promise<Page>,
  ) => (await drain(read)).cursor;
  const of = (items: Item[], conversationId: string) =>
    items.filter(
      (i) =>
        (i.type === 'conversation' ? i.data.id : i.data.conversationId) ===
        conversationId,
    );

  const conversation = async (others: KeyedUser[] = [ana]) => {
    const conv = await k.create(olivia, spaceId, {
      executor: hubRecipientOf(casa),
    });
    await expectStatus(Promise.resolve(conv.res), 201);
    if (others.length) {
      await expectStatus(
        k.share(olivia, spaceId, conv.id, others.map(recipientOf), conv.keys),
        200,
      );
    }
    return { id: conv.id, keys: conv.keys as ConversationKeys };
  };
  const send = async (
    user: KeyedUser,
    conv: { id: string; keys: ConversationKeys },
    text: string,
    opts: { replacesMessageId?: string } = {},
  ) => {
    const sent = await k.send(user, spaceId, conv.id, conv.keys, {
      text,
      ...opts,
    });
    await expectStatus(Promise.resolve(sent.res), 201);
    return sent;
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
    oliviaKit = o.kit.publicKey;
    for (const u of [ana, bruno, paulo]) await s.joinOrg(olivia, orgId, u);

    casa = await h.onboard(olivia.token, 'Casa');
    pauloHub = await h.onboard(paulo.token, 'Paulo');
    await hubs.link(olivia, casa.hubId, orgId);
    const pl = await hubs.link(paulo, pauloHub.hubId, orgId);
    if (pl.status !== 'approved') {
      await hubs.approve(olivia, pauloHub.hubId, orgId);
    }
    const sp = await s.create(olivia, orgId, o.kit.publicKey, 'Projetos', {
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
    casaToken = await h.authenticate(casa);
    pauloToken = await h.authenticate(pauloHub);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  });

  describe('person feed', () => {
    it('a participant gets the conversation, participants, OWN copies, messages and attachment metadata; a space member who does not participate gets nothing (Review Focus 1)', async () => {
      const conv = await conversation([ana]);
      const sent = await send(olivia, conv, 'liga a luz da sala');
      await send(ana, conv, 'feito');
      const attachmentId = newId();
      await expectStatus(
        http()
          .post(`/spaces/${spaceId}/conversations/${conv.id}/attachments`)
          .set(bearer(ana.token))
          .send({
            id: attachmentId,
            keyVersion: 1,
            sizeBytes: 300,
            sha256: createHash('sha256').update(randomBytes(300)).digest('hex'),
          }),
        201,
      );

      for (const user of [olivia, ana]) {
        // The organization of the space plus the person's personal one.
        const page = await feed(user);
        expect(page.organizationIds).toContain(orgId);
        const items = of((await drainUser(user)).items, conv.id);
        const types = (t: string) => items.filter((i) => i.type === t);
        expect(types('conversation')).toHaveLength(1);
        expect(types('conversation')[0]!.data).toMatchObject({
          id: conv.id,
          organizationId: orgId,
          spaceId,
          ownerUserId: olivia.userId,
          executorHubId: casa.hubId,
          currentKeyVersion: 1,
          encryptedHeader: expect.any(String),
        });
        expect(
          types('conversation_participant').map((i) => i.data.userId),
        ).toEqual(expect.arrayContaining([olivia.userId, ana.userId]));
        expect(types('conversation_participant')).toHaveLength(2);
        // Only the reader's own copy: never the other participant's nor the hub's.
        const grants = types('conversation_key_grant');
        expect(grants.map((g) => g.data.userId)).toEqual([user.userId]);
        expect(grants.every((g) => g.data.hubId === null)).toBe(true);
        expect(await k.open(user, grants[0]!.data.wrappedKey)).toEqual(
          conv.keys[0],
        );
        const messages = types('conversation_message');
        expect(messages).toHaveLength(2);
        const mine = messages.find((m) => m.data.id === sent.id)!;
        expect(mine.data).toMatchObject({
          authorUserId: olivia.userId,
          pending: true,
          keyVersion: 1,
        });
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
              Buffer.from(mine.data.encryptedBody, 'base64url'),
            ),
          ),
        ).toBe('liga a luz da sala');
        const [attachment] = types('conversation_attachment');
        expect(attachment!.data).toEqual({
          id: attachmentId,
          conversationId: conv.id,
          messageId: null,
          keyVersion: 1,
          sizeBytes: 300,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          status: 'pending',
          uploadedByUserId: ana.userId,
          uploadedByHubId: null,
          createdAt: expect.any(String),
        });
        // Versions ascend; the page carries no S3 detail.
        const versions = items.map((i) => i.syncVersion);
        expect([...versions].sort((a, b) => a - b)).toEqual(versions);
        // Field names only: random base64url values (bodies, copies) may contain "s3".
        const keys = (v: unknown): string[] =>
          v && typeof v === 'object'
            ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)])
            : [];
        expect(keys(items).filter((k) => /s3|uploadExpires/i.test(k))).toEqual(
          [],
        );
        // Values: no S3 host, signature or object key (none of these can come out of base64url by chance).
        expect(JSON.stringify(items)).not.toMatch(
          /amazonaws|X-Amz-|\/conversations\//,
        );
      }

      // Bruno is a member of the space and of the organization, with the right ids in hand: nothing.
      const brunoAll = await drainUser(bruno);
      expect(brunoAll.items).toEqual([]);
      expect((await feed(bruno)).organizationIds).toContain(orgId);
      expect(
        (await feed(bruno, { conversationId: conv.id, since: 0 })).items,
      ).toEqual([]);
      // And the hub of someone else (Paulo's, same organization and space) sees nothing either.
      expect(of((await drainHub(pauloToken)).items, conv.id)).toEqual([]);
    });

    it('tombstones reach the feed: a deleted message carries only its keys; who leaves gets the tombstones of their own participation and copies, and nothing after', async () => {
      const conv = await conversation([ana]);
      const m = await send(ana, conv, 'apaga isto');
      const anaCursor = await cursorOf((q) => feed(ana, q));
      const oliviaCursor = await cursorOf((q) => feed(olivia, q));

      await expectStatus(
        http()
          .delete(
            `/spaces/${spaceId}/conversations/${conv.id}/messages/${m.id}`,
          )
          .set(bearer(ana.token)),
        204,
      );
      const deleted = of((await drainUser(ana, anaCursor)).items, conv.id);
      expect(deleted.map((i) => [i.type, i.deleted, i.data])).toEqual([
        ['conversation_message', true, { id: m.id, conversationId: conv.id }],
      ]);

      await expectStatus(k.leave(ana, spaceId, conv.id), 204);
      // A change after the exit (the key rotation is pending, so a state change rather than a message).
      await expectStatus(
        k.setState(olivia, spaceId, conv.id, 'arquivado'),
        200,
      );

      const anaItems = of((await drainUser(ana, anaCursor)).items, conv.id);
      expect(
        anaItems.map((i) => [i.type, i.deleted, Object.keys(i.data).sort()]),
      ).toEqual(
        expect.arrayContaining([
          [
            'conversation_participant',
            true,
            ['conversationId', 'id', 'userId'],
          ],
          [
            'conversation_key_grant',
            true,
            ['conversationId', 'hubId', 'id', 'keyVersion', 'userId'],
          ],
        ]),
      );
      const own = anaItems.filter((i) => i.type === 'conversation_participant');
      expect(own.at(-1)!.data.userId).toBe(ana.userId);
      // After leaving: no live item of the conversation (not even the archived conversation).
      const afterLeave = anaItems.slice(
        anaItems.findIndex(
          (i) => i.type === 'conversation_participant' && i.deleted,
        ),
      );
      expect(afterLeave.filter((i) => !i.deleted)).toEqual([]);
      expect(
        (await feed(ana, { conversationId: conv.id, since: 0 })).items.every(
          (i) =>
            i.deleted &&
            ['conversation_participant', 'conversation_key_grant'].includes(
              i.type,
            ),
        ),
      ).toBe(true);

      // Olivia sees Ana's exit and the pending rotation.
      const oliviaItems = of(
        (await drainUser(olivia, oliviaCursor)).items,
        conv.id,
      );
      expect(
        oliviaItems.some(
          (i) =>
            i.type === 'conversation_participant' &&
            i.deleted &&
            i.data.userId === ana.userId,
        ),
      ).toBe(true);
      expect(
        oliviaItems.findLast((i) => i.type === 'conversation')!.data,
      ).toMatchObject({ keyRotationRequired: true, state: 'arquivado' });
    });

    it('an edit never delivers the tombstone of the original before the replacement, even across a page boundary', async () => {
      const conv = await conversation([]);
      const original = await send(olivia, conv, 'versao 1');
      const cursor = await cursorOf((q) => feed(olivia, q));
      const edit = await send(olivia, conv, 'versao 2', {
        replacesMessageId: original.id,
      });

      // One item per page: the boundary falls between every pair of rows.
      const pages: Item[][] = [];
      let since = cursor;
      for (;;) {
        const page = await feed(olivia, { since, limit: 1 });
        if (page.items.length === 0) break;
        expect(page.items).toHaveLength(1);
        pages.push(page.items);
        since = page.nextSince;
      }
      const flat = pages.flat();
      const replacement = flat.findIndex((i) => i.data.id === edit.id);
      const tombstone = flat.findIndex(
        (i) => i.data.id === original.id && i.deleted,
      );
      expect(replacement).toBeGreaterThanOrEqual(0);
      expect(tombstone).toBeGreaterThan(replacement);
      expect(flat[replacement]!.data.replacesMessageId).toBe(original.id);
    });

    it('validates the query', async () => {
      for (const query of [
        { limit: 0 },
        { limit: 501 },
        { since: -1 },
        { conversationId: 'nope' },
      ]) {
        await expectStatus(
          http()
            .get('/conversations/changes')
            .query(query)
            .set(bearer(olivia.token)),
          422,
        );
      }
      await expectStatus(http().get('/conversations/changes'), 401);
      // A user token on the hub feed, a hub token on the person feed: 401.
      await expectStatus(
        http().get('/hub/conversations/changes').set(bearer(olivia.token)),
        401,
      );
      await expectStatus(
        http().get('/conversations/changes').set(bearer(casaToken)),
        401,
      );
    });
  });

  describe('executor feed', () => {
    it('the executor gets its conversations with ITS copies only; losing the role brings the tombstones of its copies; the new executor backfills by conversation', async () => {
      const conv = await conversation([ana, paulo]);
      const sent = await send(ana, conv, 'pro copiloto');
      const casaItems = of((await drainHub(casaToken)).items, conv.id);
      const grants = casaItems.filter(
        (i) => i.type === 'conversation_key_grant',
      );
      expect(grants.map((g) => [g.data.hubId, g.data.userId])).toEqual([
        [casa.hubId, null],
      ]);
      expect(await k.hubOpens(casa, grants[0]!.data.wrappedKey)).toEqual(
        conv.keys[0],
      );
      expect(
        casaItems.some(
          (i) => i.type === 'conversation_message' && i.data.id === sent.id,
        ),
      ).toBe(true);
      expect(
        casaItems.filter((i) => i.type === 'conversation_participant'),
      ).toHaveLength(3);
      expect(of((await drainHub(pauloToken)).items, conv.id)).toEqual([]);

      // Paulo's hub works on another conversation written after the message, so its cursor is already past it.
      const own = await k.create(paulo, spaceId, {
        executor: hubRecipientOf(pauloHub),
      });
      await expectStatus(Promise.resolve(own.res), 201);
      const casaCursor = await cursorOf((q) => hubFeed(casaToken, q));
      const pauloCursor = await cursorOf((q) => hubFeed(pauloToken, q));
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

      // The old executor: tombstones of its own copies, nothing live.
      const lost = of((await drainHub(casaToken, casaCursor)).items, conv.id);
      expect(lost.length).toBeGreaterThan(0);
      expect(lost.every((i) => i.deleted)).toBe(true);
      expect(lost.map((i) => [i.type, i.data.hubId])).toEqual([
        ['conversation_key_grant', casa.hubId],
      ]);

      // The new executor: the conversation enters its scope; the old message keeps its old version, so it comes with
      // the per-conversation backfill (since=0), not with the incremental pass.
      const entered = of(
        (await drainHub(pauloToken, pauloCursor)).items,
        conv.id,
      );
      expect(
        entered.find((i) => i.type === 'conversation')!.data.executorHubId,
      ).toBe(pauloHub.hubId);
      expect(entered.some((i) => i.data.id === sent.id)).toBe(false);
      const backfill = (
        await drainHub(pauloToken, 0, { conversationId: conv.id })
      ).items;
      expect(backfill.every((i) => of([i], conv.id).length === 1)).toBe(true);
      expect(backfill.some((i) => i.data.id === sent.id)).toBe(true);
      expect(
        backfill
          .filter((i) => i.type === 'conversation_key_grant')
          .map((g) => g.data.hubId),
      ).toEqual([pauloHub.hubId]);
    });

    it('an organization whose link is no longer approved stays out of the executor feed', async () => {
      const conv = await conversation([]);
      await send(olivia, conv, 'oi');
      expect(of((await drainHub(casaToken)).items, conv.id)).not.toEqual([]);
      const admin = await adminDataSource();
      // The link alone, without the unlink cascade (the executor stays set): the reader's filter is what keeps it out.
      await admin.query(
        `UPDATE hub_organization SET status = 'pending' WHERE hub_id = $1 AND organization_id = $2`,
        [casa.hubId, orgId],
      );
      try {
        const page = await hubFeed(casaToken, { since: 0 });
        expect(page.organizationIds).not.toContain(orgId);
        expect(page.items).toEqual([]);
        expect(
          (await hubFeed(casaToken, { since: 0, conversationId: conv.id }))
            .items,
        ).toEqual([]);
      } finally {
        await admin.query(
          `UPDATE hub_organization SET status = 'approved' WHERE hub_id = $1 AND organization_id = $2`,
          [casa.hubId, orgId],
        );
      }
      expect((await hubFeed(casaToken)).organizationIds).toContain(orgId);
    });

    it('validates wait', async () => {
      for (const wait of [-1, 26, 'x']) {
        await expectStatus(
          http()
            .get('/hub/conversations/changes')
            .query({ wait })
            .set(bearer(casaToken)),
          422,
        );
      }
    });
  });

  describe('long poll', () => {
    const signal = () => app.get(PgConversationChangeSignal);

    /** Starts a long poll and resolves with its page and the time it answered. */
    const longPoll = (token: string, since: number, wait: number) =>
      hubFeed(token, { since, wait }).then((page) => ({
        page,
        at: Date.now(),
      }));
    const untilWaiting = async (n: number) => {
      for (let i = 0; i < 200 && signal().waiting() < n; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(signal().waiting()).toBeGreaterThanOrEqual(n);
    };

    it('wakes within 2 s of a new message from a person', async () => {
      const conv = await conversation([ana]);
      const cursor = await cursorOf((q) => hubFeed(casaToken, q));
      const started = Date.now();
      const poll = longPoll(casaToken, cursor, 20);
      await untilWaiting(1);
      await new Promise((r) => setTimeout(r, 300));
      const sendAt = Date.now();
      const sent = await send(ana, conv, 'acorda');
      const { page, at } = await poll;
      expect(at - sendAt).toBeLessThan(2_000);
      expect(at - started).toBeLessThan(10_000);
      expect(
        page.items.some(
          (i) => i.type === 'conversation_message' && i.data.id === sent.id,
        ),
      ).toBe(true);
    });

    it('answers at once when there is already something to read', async () => {
      const conv = await conversation([]);
      const cursor = await cursorOf((q) => hubFeed(casaToken, q));
      await send(olivia, conv, 'ja tem');
      const started = Date.now();
      const { page } = await longPoll(casaToken, cursor, 20);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(page.items.length).toBeGreaterThan(0);
    });

    it('a missed NOTIFY still returns the change (the re-read at the deadline sees it)', async () => {
      const conv = await conversation([]);
      const cursor = await cursorOf((q) => hubFeed(casaToken, q));
      const drop = vi.spyOn(signal(), 'dispatch').mockImplementation(() => {});
      try {
        const poll = longPoll(casaToken, cursor, 3);
        await untilWaiting(1);
        const sent = await send(olivia, conv, 'ninguem avisou');
        const { page } = await poll;
        expect(drop).toHaveBeenCalled();
        expect(page.items.some((i) => i.data.id === sent.id)).toBe(true);
      } finally {
        drop.mockRestore();
      }
      // And the next poll from the old cursor gets it too.
      expect(
        (await hubFeed(casaToken, { since: cursor })).items.length,
      ).toBeGreaterThan(0);
    });

    it('20 long polls in parallel hold no database connection: normal requests are still served; over the per-hub cap a poll answers at once', async () => {
      const extra: ClaimedHub[] = [];
      for (let i = 0; i < 10; i++) {
        extra.push(await h.onboard(paulo.token, `Extra ${i}`));
      }
      const tokens = await Promise.all(extra.map((x) => h.authenticate(x)));
      const before = signal().waiting();
      const polls = tokens.flatMap((t) => [
        longPoll(t, 0, 4),
        longPoll(t, 0, 4),
      ]);
      await untilWaiting(before + 20);

      // A third poll of the same hub does not wait.
      const capStart = Date.now();
      await hubFeed(tokens[0]!, { since: 0, wait: 4 });
      expect(Date.now() - capStart).toBeLessThan(1_500);

      // The pool has 10 connections: 20 more normal requests in parallel, all served while the polls wait.
      const started = Date.now();
      const normal = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          i % 2
            ? http().get(`/spaces/${spaceId}`).set(bearer(olivia.token))
            : http().get('/conversations/changes').set(bearer(ana.token)),
        ),
      );
      expect(normal.map((r) => r.status)).toEqual(Array(20).fill(200));
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(signal().waiting()).toBeGreaterThanOrEqual(before + 20);
      const admin = await adminDataSource();
      const [{ n }] = await admin.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE usename = $1 AND state LIKE 'idle in transaction%'`,
        [process.env.DB_APP_USERNAME],
      );
      expect(n).toBe(0);

      const done = await Promise.all(polls);
      expect(done.every((d) => d.page.items.length === 0)).toBe(true);
      expect(signal().waiting()).toBe(before);
    }, 60_000);
  });
  // Sessão aberta por um Hub (`POST /hub/user-sessions`): "privado é privado" — ela só alcança os assuntos cujo
  // executor é esse mesmo Hub, em toda rota de usuário dos assuntos e no feed da pessoa.
  describe('a session opened through a hub', () => {
    const expectProblem = (
      res: request.Response,
      status: number,
      type: string,
    ) => {
      expect([res.status, String(res.body.type).split('/').pop()]).toEqual([
        status,
        type,
      ]);
    };
    it("reaches only the conversations that hub executes: Olivia on Paulo's hub sees Y (executor Paulo's hub), never X (executor her own hub)", async () => {
      const x = await conversation([]); // executor: casa (Olivia's hub)
      const yCreated = await k.create(olivia, spaceId);
      await expectStatus(Promise.resolve(yCreated.res), 201);
      const y = { id: yCreated.id, keys: yCreated.keys as ConversationKeys };
      // The executor rule: the owner of Paulo's hub participates.
      await expectStatus(
        k.share(olivia, spaceId, y.id, [recipientOf(paulo)], y.keys),
        200,
      );
      await expectStatus(
        k.changeExecutor(
          olivia,
          spaceId,
          y.id,
          hubRecipientOf(pauloHub),
          y.keys,
        ),
        200,
      );
      const sentX = await send(olivia, x, 'so no meu hub');
      const sentY = await send(olivia, y, 'no hub do paulo');

      const login = await expectStatus(
        h.loginPerson(
          pauloToken,
          olivia.email,
          olivia.account.authProof,
          'Sala do Paulo',
        ),
        200,
      );
      const onHub = {
        ...olivia,
        token: login.body.session.accessToken as string,
      } as KeyedUser;

      // The person feed through the hub-bound session: Y only (no item of X: not even her own copies or participation).
      const items = (await drainUser(onHub)).items;
      expect(of(items, y.id).length).toBeGreaterThan(0);
      expect(of(items, x.id)).toEqual([]);
      expect(items.some((i) => i.data.id === sentY.id)).toBe(true);
      expect(items.some((i) => i.data.id === sentX.id)).toBe(false);
      expect(
        (await feed(onHub, { conversationId: x.id, since: 0 })).items,
      ).toEqual([]);
      // Her phone session still sees both.
      const phone = (await drainUser(olivia)).items;
      expect(of(phone, x.id).length).toBeGreaterThan(0);
      expect(of(phone, y.id).length).toBeGreaterThan(0);

      // The user routes: X is 404 through the hub-bound session (read, send, header), Y works.
      expectProblem(
        await k.get(onHub, spaceId, x.id),
        404,
        'conversation-not-found',
      );
      await expectStatus(k.get(onHub, spaceId, y.id), 200);
      expectProblem(
        (await k.send(onHub, spaceId, x.id, x.keys)).res,
        404,
        'conversation-not-found',
      );
      await expectStatus(
        Promise.resolve((await k.send(onHub, spaceId, y.id, y.keys)).res),
        201,
      );
      expectProblem(
        (await k.replaceHeader(onHub, spaceId, x.id, x.keys)).res,
        404,
        'conversation-not-found',
      );
      expectProblem(
        await k.leave(onHub, spaceId, x.id),
        404,
        'conversation-not-found',
      );
      // Creating through it: only with that hub as executor (here Olivia's own hub: refused).
      expectProblem(
        (await k.create(onHub, spaceId, { executor: hubRecipientOf(casa) }))
          .res,
        422,
        'executor-invalid',
      );
      expectProblem(
        (await k.create(onHub, spaceId)).res,
        422,
        'executor-invalid',
      );
    });
  });
  // Por último no arquivo: o teste de volume deixa ~66 mil mensagens no espaço.
  // Versões atribuídas no COMMIT, na ordem dos commits (migration ConversationFeedCommitOrder,
  // `addCommitOrderedSyncVersion`): quem confirma depois pega versão maior, sem depender de outras transações do banco.
  describe('commit-ordered versions', () => {
    const FEED_TABLES = [
      'conversations',
      'conversation_participants',
      'conversation_key_grants',
      'conversation_messages',
      'conversation_attachments',
    ];
    const owner = () => adminDataSource();
    const maxVersion = async () => {
      const [{ v }] = (await (
        await owner()
      ).query(
        `SELECT COALESCE(MAX(v), 0)::text AS v FROM (${FEED_TABLES.map((t) => `SELECT MAX(sync_version) AS v FROM ${t}`).join(' UNION ALL ')}) m`,
      )) as [{ v: string }];
      return Number(v);
    };
    const pendingRows = async () => {
      const [{ n }] = (await (
        await owner()
      ).query(
        `SELECT (${FEED_TABLES.map((t) => `(SELECT count(*) FROM ${t} WHERE sync_pending)`).join(' + ')})::int AS n`,
      )) as [{ n: number }];
      return n;
    };
    // Two spaces: in the same space the second send would wait for the first on the usage counter row.
    let space2: string;
    beforeAll(async () => {
      const sp2 = await s.create(olivia, orgId, oliviaKit, 'Outro', {
        storageQuotaBytes: GiB,
      });
      await expectStatus(Promise.resolve(sp2.res), 201);
      space2 = sp2.spaceId;
      await hubs.addSpace(olivia, casa.hubId, space2);
    });
    const otherConversation = async () => {
      const b = await k.create(olivia, space2, {
        executor: hubRecipientOf(casa),
      });
      await expectStatus(Promise.resolve(b.res), 201);
      return { id: b.id, keys: b.keys as ConversationKeys };
    };
    /** Sends A through the app's own unit of work and use case, in a transaction held open until `release`. */
    const holdOpenSend = async (convA: {
      id: string;
      keys: ConversationKeys;
    }) => {
      const uow = app.get(UnitOfWork);
      const sending = app.get(SendMessageUseCase);
      const aId = newId();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let written!: () => void;
      const wrote = new Promise<void>((r) => (written = r));
      const encryptedBody = await k.messageBody(
        convA.keys[0]!,
        spaceId,
        convA.id,
        aId,
        1,
        'primeiro a gravar, confirma depois',
      );
      const held = uow.run(async () => {
        await sending.byUser(
          { userId: olivia.userId, sessionId: newId() },
          spaceId,
          convA.id,
          { id: aId, keyVersion: 1, encryptedBody, replacesMessageId: null },
        );
        written();
        await gate;
      });
      await wrote;
      return { aId, release, held };
    };

    it('inverted commit order: the later commit is served at once, the earlier one comes after it with a higher version; nextSince never skips (executor long poll and person)', async () => {
      const convA = await conversation([]);
      const b = await otherConversation();
      const hubCursor = await cursorOf((q) => hubFeed(casaToken, q));
      const userCursor = await cursorOf((q) => feed(olivia, q));

      const { aId, release, held } = await holdOpenSend(convA);
      try {
        // B: written after A, committed first.
        const sentB = await k.send(olivia, space2, b.id, b.keys, {
          text: 'segundo a gravar, confirma antes',
        });
        await expectStatus(Promise.resolve(sentB.res), 201);

        // B is served right away (no wait for A), and A is not there yet.
        const early = await drainHub(casaToken, hubCursor);
        const earlyIds = early.items.map((i) => i.data.id);
        expect(earlyIds).toContain(sentB.id);
        expect(earlyIds).not.toContain(aId);
        const earlyUser = await drainUser(olivia, userCursor);
        expect(earlyUser.items.map((i) => i.data.id)).toContain(sentB.id);
        expect(earlyUser.items.map((i) => i.data.id)).not.toContain(aId);

        // The executor long-polls from the cursor that already passed B; A commits during the wait.
        const poll = hubFeed(casaToken, { since: early.cursor, wait: 10 });
        await new Promise((r) => setTimeout(r, 300));
        release();
        await held;
        const page = await poll;
        const a = page.items.find(
          (i) => i.type === 'conversation_message' && i.data.id === aId,
        );
        expect(a).toBeDefined();
        const bItem = early.items.find((i) => i.data.id === sentB.id)!;
        expect(a!.syncVersion).toBeGreaterThan(bItem.syncVersion);

        // The person, from the cursor that already passed B, gets A too.
        const after = await drainUser(olivia, earlyUser.cursor);
        expect(after.items.map((i) => i.data.id)).toContain(aId);
      } finally {
        release();
        await held.catch(() => undefined);
      }
    }, 30_000);

    it('an unrelated long transaction (row lock held open on another table) does not delay a message reaching the executor (< 2 s)', async () => {
      const conv = await conversation([ana]);
      const cursor = await cursorOf((q) => hubFeed(casaToken, q));
      const qr = (await owner()).createQueryRunner();
      await qr.connect();
      try {
        await qr.startTransaction();
        await qr.query('SELECT pg_current_xact_id()');
        await qr.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [
          bruno.userId,
        ]);
        const poll = hubFeed(casaToken, { since: cursor, wait: 20 });
        await new Promise((r) => setTimeout(r, 300));
        const sendAt = Date.now();
        const sent = await send(ana, conv, 'nao espera ninguem');
        const page = await poll;
        expect(Date.now() - sendAt).toBeLessThan(2_000);
        expect(page.items.map((i) => i.data.id)).toContain(sent.id);
      } finally {
        await qr.rollbackTransaction().catch(() => undefined);
        await qr.release();
      }
    }, 30_000);

    it('a cursor equal to the greatest version already served returns only newer rows', async () => {
      const conv = await conversation([]);
      await cursorOf((q) => hubFeed(casaToken, q));
      const old = await maxVersion();
      const [{ next }] = (await (
        await owner()
      ).query(
        `SELECT last_value::text AS next FROM conversation_sync_version_seq`,
      )) as [{ next: string }];
      expect(Number(next)).toBeGreaterThanOrEqual(old);
      const sent = await send(olivia, conv, 'depois do cursor');
      const page = await drainHub(casaToken, old);
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.every((i) => i.syncVersion > old)).toBe(true);
      expect(of(page.items, conv.id).length).toBe(page.items.length);
      expect(page.items.map((i) => i.data.id)).toContain(sent.id);
    });

    it('the advisory lock orders the commits: T2 waits at COMMIT while T1 holds the lock, T2 gets the higher version, and no read sees T2 without T1', async () => {
      const c1 = await conversation([]);
      const c2 = await otherConversation();
      const cursor = await cursorOf((q) => feed(olivia, q));
      const insert = (convId: string) =>
        `INSERT INTO conversation_messages
           (id, organization_id, conversation_id, author_user_id, key_version, encrypted_body, body_bytes, pending,
            sent_at)
         SELECT uuidv7(), c.organization_id, c.id, c.owner_user_id, 1, 'AAAA', 3, true, clock_timestamp()
           FROM conversations c WHERE c.id = '${convId}'
         RETURNING id`;
      const ds = await owner();
      const t1 = ds.createQueryRunner();
      const t2 = ds.createQueryRunner();
      await t1.connect();
      await t2.connect();
      let reading = true;
      const seen: string[][] = [];
      const readers = (async () => {
        while (reading) {
          const page = await feed(olivia, { since: cursor });
          seen.push(page.items.map((i) => i.data.id as string));
        }
      })();
      try {
        // T1 writes and, ONLY in this test, takes its versions (and the advisory lock) now, holding them.
        await t1.startTransaction();
        const [{ id: m1 }] = (await t1.query(insert(c1.id))) as [
          { id: string },
        ];
        await t1.query('SET CONSTRAINTS ALL IMMEDIATE');
        // T2 writes another space's conversation (no shared row lock) and commits: it waits on the advisory lock.
        await t2.startTransaction();
        const [{ pid }] = (await t2.query(
          'SELECT pg_backend_pid() AS pid',
        )) as [{ pid: number }];
        const [{ id: m2 }] = (await t2.query(insert(c2.id))) as [
          { id: string },
        ];
        const committing2 = t2.commitTransaction();
        let waiting = false;
        for (let i = 0; i < 200 && !waiting; i++) {
          const rows = (await ds.query(
            `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND pid = $1`,
            [pid],
          )) as unknown[];
          waiting = rows.length > 0;
          if (!waiting) await new Promise((r) => setTimeout(r, 25));
        }
        expect(waiting).toBe(true);
        const meanwhile = (await feed(olivia, { since: cursor })).items.map(
          (i) => i.data.id,
        );
        expect(meanwhile).not.toContain(m1);
        expect(meanwhile).not.toContain(m2);

        await t1.commitTransaction();
        await committing2;
        reading = false;
        await readers;

        const versions = (await ds.query(
          `SELECT id, sync_version::text AS v FROM conversation_messages WHERE id = ANY($1)`,
          [[m1, m2]],
        )) as { id: string; v: string }[];
        const v = new Map(versions.map((r) => [r.id, BigInt(r.v)]));
        expect(v.get(m2)! > v.get(m1)!).toBe(true);
        const final = (await drainUser(olivia, cursor)).items.map(
          (i) => i.data.id,
        );
        expect(final).toEqual(expect.arrayContaining([m1, m2]));
        expect(seen.length).toBeGreaterThan(0);
        for (const ids of seen) {
          if (ids.includes(m2)) expect(ids).toContain(m1);
        }
      } finally {
        reading = false;
        await readers.catch(() => undefined);
        if (t1.isTransactionActive) await t1.rollbackTransaction();
        if (t2.isTransactionActive)
          await t2.rollbackTransaction().catch(() => undefined);
        await t1.release();
        await t2.release();
      }
    }, 30_000);

    it('the special RLS write paths commit and every row they wrote gets its version: leave (WHERE CURRENT OF), the last participant leaving, executor lost in a participant context', async () => {
      const before = await maxVersion();
      const anaCursor = await cursorOf((q) => feed(ana, q));
      // Ana leaves: the participants trigger rewrites the conversation with WHERE CURRENT OF, and at commit the
      // conversation is no longer visible in her context.
      const conv1 = await conversation([ana]);
      await expectStatus(k.leave(ana, spaceId, conv1.id), 204);
      // Olivia, the last participant, leaves: the conversation becomes invisible to every runtime context.
      const conv2 = await conversation([]);
      await expectStatus(k.leave(olivia, spaceId, conv2.id), 204);
      // The space leaves the Hub: executor lost, written in the conversation owner's context.
      const conv3 = await otherConversation();
      await hubs.removeSpace(olivia, casa.hubId, space2);

      expect(await pendingRows()).toBe(0);
      const rows = (await (
        await owner()
      ).query(
        `SELECT id, sync_version::text AS v, executor_hub_id, participant_user_ids, deleted_at IS NOT NULL AS gone
           FROM conversations WHERE id = ANY($1)`,
        [[conv1.id, conv2.id, conv3.id]],
      )) as {
        id: string;
        v: string;
        executor_hub_id: string | null;
        participant_user_ids: string[];
        gone: boolean;
      }[];
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(conv1.id)!.participant_user_ids).not.toContain(
        ana.userId,
      );
      expect(byId.get(conv2.id)!.gone).toBe(true);
      expect(byId.get(conv3.id)!.executor_hub_id).toBeNull();
      for (const r of rows) expect(Number(r.v)).toBeGreaterThan(before);
      const grants = (await (
        await owner()
      ).query(
        `SELECT sync_version::text AS v FROM conversation_key_grants
          WHERE conversation_id = $1 AND hub_id = $2 AND deleted_at IS NOT NULL`,
        [conv3.id, casa.hubId],
      )) as { v: string }[];
      expect(grants.length).toBeGreaterThan(0);
      for (const g of grants) expect(Number(g.v)).toBeGreaterThan(before);

      // Ana's feed brings the tombstone of her own participation.
      const anaItems = (await drainUser(ana, anaCursor)).items;
      expect(
        anaItems.some(
          (i) =>
            i.type === 'conversation_participant' &&
            i.data.conversationId === conv1.id &&
            i.deleted,
        ),
      ).toBe(true);
    }, 30_000);

    it('more than 65,535 rows in one transaction: every row gets its own version and paging delivers all of them', async () => {
      const conv = await conversation([]);
      const cursor = await maxVersion();
      const N = 66_000;
      await (
        await owner()
      ).transaction(async (m) => {
        await m.query(
          `INSERT INTO conversation_messages
             (id, organization_id, conversation_id, author_user_id, key_version, encrypted_body, body_bytes, pending,
              sent_at)
           SELECT uuidv7(), c.organization_id, c.id, c.owner_user_id, 1, 'AAAA', 3, true, clock_timestamp()
             FROM conversations c, generate_series(1, $2::int)
            WHERE c.id = $1`,
          [conv.id, N],
        );
      });
      const [stats] = (await (
        await owner()
      ).query(
        `SELECT count(*)::int AS n, count(DISTINCT sync_version)::int AS d, bool_or(sync_pending) AS pending
           FROM conversation_messages WHERE conversation_id = $1`,
        [conv.id],
      )) as [{ n: number; d: number; pending: boolean }];
      expect(stats).toEqual({ n: N, d: N, pending: false });
      const ids = new Set(
        (await drainUser(olivia, cursor, { conversationId: conv.id })).items
          .filter((i) => i.type === 'conversation_message')
          .map((i) => i.data.id),
      );
      expect(ids.size).toBe(N);
    }, 300_000);
  });
});
