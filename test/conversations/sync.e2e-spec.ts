import { createHash, randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PgConversationChangeSignal } from '../../src/conversations/infra/db/pg-conversation-change-signal.js';
import { newId } from '../../src/shared/domain/id.js';
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
});
