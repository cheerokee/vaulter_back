import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AgentProposalRetention } from '../../src/cloud/application/brain/agent-proposal-retention.js';
import { ConversationUsageReconcile } from '../../src/conversations/application/conversation-usage-reconcile.js';
import { HubRegistryCleanup } from '../../src/hubs/application/hub-registry-cleanup.js';
import { newId } from '../../src/shared/domain/id.js';
import {
  runWithContext,
  type UnitOfWorkContext,
} from '../../src/shared/infra/db/unit-of-work.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import {
  conversationSpaceUsage,
  conversationsKit,
  type ConversationKeys,
} from '../support/conversations-kit.js';
import { hubClient } from '../support/hub-client.js';
import {
  expectStatus,
  identityClient,
  recipientOf,
  type KeyedUser,
} from '../support/identity-client.js';

type Conv = { id: string; keys: ConversationKeys };

const hex64 = () => randomBytes(32).toString('hex');

// Os contextos de confiança das rotinas de manutenção (migration MaintenanceTrustedContexts; decisão B7): pelo login
// de RUNTIME, cada contexto enxerga e grava só as linhas candidatas da sua rotina, e nada além (nem as outras tabelas da
// organização, nem participações e cópias da chave dos assuntos, nem linhas dentro da janela de 30 dias).
describe('trusted maintenance contexts (e2e)', () => {
  let app: INestApplication;
  const c = identityClient(() => app);
  const s = c.spaces;
  const h = hubClient(() => app);
  const k = conversationsKit(() => app);

  let olivia: KeyedUser;
  let ana: KeyedUser;
  let orgId: string;
  let spaceA: string;
  let spaceB: string;
  let hubId: string;
  // Space A: `live` (messages deleted 31 days ago, 29 days ago and not deleted) and `gone` (tombstoned 31 days ago).
  // Space B: `other` (a message deleted 31 days ago).
  let live: Conv;
  let gone: Conv;
  let other: Conv;
  let mOld: string;
  let mRecent: string;
  let mLive: string;
  let nGone: string;
  let xOld: string;

  /** Runs `sql` with the runtime login in `ctx` (its own transaction, as the routines do). */
  const runtime = <T = Record<string, unknown>>(
    ctx: UnitOfWorkContext,
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> =>
    runWithContext(app.get(DataSource), ctx, (m) => m.query(sql, params));
  const ids = async (ctx: UnitOfWorkContext, table: string) =>
    (await runtime<{ id: string }>(ctx, `SELECT id FROM ${table}`))
      .map((r) => r.id)
      .sort();
  const count = async (ctx: UnitOfWorkContext, table: string) =>
    Number(
      (
        await runtime<{ n: string }>(ctx, `SELECT count(*) AS n FROM ${table}`)
      )[0]!.n,
    );
  /** Rows an UPDATE changed (`m.query` of an UPDATE returns [rows, count]). */
  const updated = async (
    ctx: UnitOfWorkContext,
    sql: string,
    params: unknown[] = [],
  ) => (await runtime<unknown>(ctx, sql, params))[1] as unknown as number;

  const open = async (
    owner: KeyedUser,
    sp: string,
    others: KeyedUser[],
  ): Promise<Conv> => {
    const conv = await k.create(owner, sp, {});
    await expectStatus(Promise.resolve(conv.res), 201);
    if (others.length) {
      await expectStatus(
        k.share(owner, sp, conv.id, others.map(recipientOf), conv.keys),
        200,
      );
    }
    return { id: conv.id, keys: conv.keys };
  };
  const send = async (u: KeyedUser, sp: string, conv: Conv) => {
    const m = await k.send(u, sp, conv.id, conv.keys, { text: 'oi' });
    await expectStatus(Promise.resolve(m.res), 201);
    return m.id;
  };
  const del = (u: KeyedUser, sp: string, conv: Conv, id: string) =>
    expectStatus(k.deleteMessage(u, sp, conv.id, id), 204);
  const owner = async (sql: string, params: unknown[] = []) =>
    (await adminDataSource()).query(sql, params);
  const backdate = (table: string, id: string, days: number) =>
    owner(
      `UPDATE ${table} SET deleted_at = now() - make_interval(days => $2) WHERE id = $1`,
      [id, days],
    );

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    olivia = await s.signUpKeyed('olivia@example.com', 'Olivia');
    ana = await s.signUpKeyed('ana@example.com', 'Ana');
    const o = await s.orgWithKit(olivia, 'Casa');
    orgId = o.orgId;
    await s.joinOrg(olivia, orgId, ana);
    const a = await s.create(olivia, orgId, o.kit.publicKey, 'A');
    const b = await s.create(olivia, orgId, o.kit.publicKey, 'B');
    spaceA = a.spaceId;
    spaceB = b.spaceId;
    await expectStatus(
      s.addMember(
        olivia.token,
        spaceA,
        recipientOf(ana),
        [a.key],
        'space_editor',
      ),
      201,
    );

    live = await open(olivia, spaceA, [ana]);
    mOld = await send(olivia, spaceA, live);
    mRecent = await send(ana, spaceA, live);
    mLive = await send(olivia, spaceA, live);
    await del(olivia, spaceA, live, mOld);
    await del(ana, spaceA, live, mRecent);
    await backdate('conversation_messages', mOld, 31);
    await backdate('conversation_messages', mRecent, 29);

    gone = await open(olivia, spaceA, []);
    nGone = await send(olivia, spaceA, gone);
    await expectStatus(k.leave(olivia, spaceA, gone.id), 204);
    await backdate('conversations', gone.id, 31);

    other = await open(olivia, spaceB, []);
    xOld = await send(olivia, spaceB, other);
    await del(olivia, spaceB, other, xOld);
    await backdate('conversation_messages', xOld, 31);

    hubId = (await h.onboard(olivia.token, 'Casa')).hubId;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  });

  it('no context: the runtime login sees none of these rows and deletes nothing', async () => {
    expect(await count({}, 'conversations')).toBe(0);
    expect(await count({}, 'conversation_messages')).toBe(0);
    expect(await count({}, 'conversation_space_usage')).toBe(0);
    expect(await count({}, 'agent_issued_proposals')).toBe(0);
    expect(
      await updated({}, `DELETE FROM hub_auth_challenges WHERE true`),
    ).toBe(0);
  });

  describe('app.conversation_retention', () => {
    const scan = { conversationRetention: 'scan' };

    it("'scan' sees only content past the window, in every organization, and nothing else", async () => {
      expect(await ids(scan, 'conversations')).toEqual([gone.id]);
      expect(await ids(scan, 'conversation_messages')).toEqual(
        [mOld, nGone, xOld].sort(),
      );
      for (const table of [
        'conversation_participants',
        'conversation_key_grants',
        'conversation_attachments',
        'conversation_space_usage',
        'spaces',
        'organizations',
        'user_organization',
      ]) {
        expect([table, await count(scan, table)]).toEqual([table, 0]);
      }
      // Read only.
      expect(
        await updated(
          scan,
          `UPDATE conversation_messages SET updated_at = now() WHERE id = $1`,
          [mOld],
        ),
      ).toBe(0);
    });

    it('one conversation: that conversation, its due content and its space counter; writes only null the due content', async () => {
      const ctx = { conversationRetention: live.id };
      expect(await ids(ctx, 'conversations')).toEqual([live.id]);
      expect(await ids(ctx, 'conversation_messages')).toEqual([mOld]);
      expect(
        (
          await runtime<{ space_id: string }>(
            ctx,
            `SELECT space_id FROM conversation_space_usage`,
          )
        ).map((r) => r.space_id),
      ).toEqual([spaceA]);
      for (const table of [
        'conversation_participants',
        'conversation_key_grants',
        'spaces',
        'organizations',
      ]) {
        expect([table, await count(ctx, table)]).toEqual([table, 0]);
      }
      // Inside the window or alive: never written.
      for (const id of [mRecent, mLive]) {
        expect(
          await updated(
            ctx,
            `UPDATE conversation_messages SET encrypted_body = NULL, deleted_at = COALESCE(deleted_at, now()) WHERE id = $1`,
            [id],
          ),
        ).toBe(0);
      }
      // A due message may only be nulled (WITH CHECK).
      await expect(
        runtime(
          ctx,
          `UPDATE conversation_messages SET deleted_at = NULL WHERE id = $1`,
          [mOld],
        ),
      ).rejects.toThrow(/row-level security/);
      // The header of a live conversation stays.
      await expect(
        runtime(
          ctx,
          `UPDATE conversations SET encrypted_header = NULL, header_key_version = NULL WHERE id = $1`,
          [live.id],
        ),
      ).rejects.toThrow(/row-level security/);
      // Another id opens nothing.
      expect(
        await count({ conversationRetention: newId() }, 'conversations'),
      ).toBe(0);
    });
  });

  describe('app.conversation_usage_reconcile', () => {
    it("'scan' sees only the counters", async () => {
      const scan = { conversationUsageReconcile: 'scan' };
      expect(
        (
          await runtime<{ space_id: string }>(
            scan,
            `SELECT space_id FROM conversation_space_usage`,
          )
        )
          .map((r) => r.space_id)
          .sort(),
      ).toEqual([spaceA, spaceB].sort());
      expect(await count(scan, 'conversations')).toBe(0);
      expect(await count(scan, 'conversation_messages')).toBe(0);
      expect(
        await updated(
          scan,
          `UPDATE conversation_space_usage SET updated_at = now()`,
        ),
      ).toBe(0);
    });

    it('one space: reads its conversations and messages (read only) and writes only its counter', async () => {
      const ctx = { conversationUsageReconcile: spaceA };
      expect(await ids(ctx, 'conversations')).toEqual(
        [live.id, gone.id].sort(),
      );
      expect(await ids(ctx, 'conversation_messages')).toEqual(
        [mOld, mRecent, mLive, nGone].sort(),
      );
      for (const table of [
        'conversation_participants',
        'conversation_key_grants',
        'conversation_attachments',
        'spaces',
      ]) {
        expect([table, await count(ctx, table)]).toEqual([table, 0]);
      }
      expect(
        await updated(
          ctx,
          `UPDATE conversation_messages SET updated_at = now() WHERE id = $1`,
          [mLive],
        ),
      ).toBe(0);
      expect(
        await updated(
          ctx,
          `UPDATE conversations SET updated_at = now() WHERE id = $1`,
          [live.id],
        ),
      ).toBe(0);
      expect(
        await updated(
          ctx,
          `UPDATE conversation_space_usage SET updated_at = now() WHERE space_id = $1`,
          [spaceA],
        ),
      ).toBe(1);
      expect(
        await updated(
          ctx,
          `UPDATE conversation_space_usage SET updated_at = now() WHERE space_id = $1`,
          [spaceB],
        ),
      ).toBe(0);
      // Without the context, a direct write is refused by the guard trigger.
      await expect(
        runtime(
          { organizationId: orgId },
          `UPDATE conversation_space_usage SET body_bytes = body_bytes WHERE space_id = $1`,
          [spaceA],
        ),
      ).rejects.toThrow(/maintained only by the conversation triggers/);
    });

    it('the recount sets a drifted counter back and leaves the right ones', async () => {
      const right = await conversationSpaceUsage(spaceA);
      await owner(
        `UPDATE conversation_space_usage SET body_bytes = body_bytes + 500, trash_bytes = 0 WHERE space_id = $1`,
        [spaceA],
      );
      expect(await app.get(ConversationUsageReconcile).run()).toEqual({
        spaces: 2,
        corrected: 1,
        failed: 0,
      });
      expect(await conversationSpaceUsage(spaceA)).toEqual(right);
      expect(await app.get(ConversationUsageReconcile).run()).toMatchObject({
        corrected: 0,
      });
    });
  });

  describe('app.hub_registry_cleanup', () => {
    it('deletes only rows expired more than 30 days ago', async () => {
      const old = newId();
      const recent = newId();
      await owner(
        `INSERT INTO hub_link_codes (id, hub_id, code_hash, expires_at)
         VALUES ($1, $3, $4, now() - interval '31 days'), ($2, $3, $5, now() - interval '29 days')`,
        [old, recent, hubId, hex64(), hex64()],
      );
      const oldChallenge = newId();
      await owner(
        `INSERT INTO hub_auth_challenges (id, hub_id, challenge_hash, expires_at)
         VALUES ($1, NULL, $2, now() - interval '31 days')`,
        [oldChallenge, hex64()],
      );
      await owner(
        `UPDATE hub_enrollments SET expires_at = now() - interval '31 days'`,
      );
      const enrollments = await count({}, 'hub_enrollments');
      const challenges = await count({}, 'hub_auth_challenges');
      expect(enrollments).toBeGreaterThan(0);

      // Outside the context: nothing.
      expect(await updated({}, `DELETE FROM hub_link_codes WHERE true`)).toBe(
        0,
      );
      // In it: never a row inside the window.
      const ctx = { hubRegistryCleanup: 'on' };
      expect(
        await updated(ctx, `DELETE FROM hub_link_codes WHERE id = $1`, [
          recent,
        ]),
      ).toBe(0);

      expect(await app.get(HubRegistryCleanup).run()).toEqual({
        hub_enrollments: enrollments,
        hub_link_codes: 1,
        hub_auth_challenges: 1,
      });
      expect(await ids({}, 'hub_link_codes')).toEqual([recent]);
      expect(await count({}, 'hub_auth_challenges')).toBe(challenges - 1);
      expect(await count({}, 'hub_enrollments')).toBe(0);
    });
  });

  describe('app.agent_proposal_retention', () => {
    it('sees and deletes only proposals older than 30 days', async () => {
      const old = newId();
      const recent = newId();
      await owner(
        `INSERT INTO agent_issued_proposals (id, organization_id, conversation_id, proposal_id, content_sha256, created_at)
         VALUES ($1, $3, $4, $5, $7, now() - interval '31 days'), ($2, $3, $4, $6, $7, now() - interval '29 days')`,
        [old, recent, orgId, live.id, newId(), newId(), hex64()],
      );
      const ctx = { agentProposalRetention: 'on' };
      expect(await ids(ctx, 'agent_issued_proposals')).toEqual([old]);
      expect(await count(ctx, 'conversations')).toBe(0);
      expect(
        await updated({}, `DELETE FROM agent_issued_proposals WHERE true`),
      ).toBe(0);
      expect(await app.get(AgentProposalRetention).run()).toBe(1);
      expect(
        (
          (await owner(`SELECT id FROM agent_issued_proposals`)) as {
            id: string;
          }[]
        ).map((r) => r.id),
      ).toEqual([recent]);
    });
  });
});
