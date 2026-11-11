import type { INestApplication } from '@nestjs/common';
import sodium from 'libsodium-wrappers-sumo';
import request from 'supertest';
import { AiBudget } from '../../src/cloud/application/ai-budget.js';
import { Embedder } from '../../src/cloud/application/ports/embedder.js';
import { AiPricing } from '../../src/cloud/domain/ai-pricing.js';
import {
  AiBudgetExceededError,
  estimateEmbeddingTokens,
} from '../../src/cloud/domain/ai-usage.js';
import { EMBEDDING_BATCH } from '../../src/cloud/domain/indexing-limits.js';
import { chunkText } from '../../src/cloud/domain/text-chunker.js';
import {
  FAKE_EMBEDDING_MODEL,
  FakeEmbedder,
} from '../../src/cloud/testing/fake-embedder.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import {
  type ClientAccount,
  createClientAccount,
} from '../support/client-crypto.js';
import {
  expectStatus,
  identityClient,
  type KeyedUser,
} from '../support/identity-client.js';
import { grantRoleInDb, platformAuditRows } from '../support/platform-kit.js';
import {
  cloudSwitch,
  setAiBudgetInDb,
  simulatedHub,
} from '../support/space-manifest.js';
import { auditRows } from '../support/spaces-db.js';

const PASSWORD = 'correct horse battery staple';
const MISSING_ID = '0190f3c0-0000-7000-8000-000000000000';
const enc = (s: string) => new TextEncoder().encode(s);

// Orçamento mensal de IA (spec active-cloud §4.4): o financeiro ajusta, os admins veem o uso, as reservas concorrentes
// nunca passam do limite e a indexação para no próximo lote e retoma quando o orçamento sobe (Review Focus 3). Workers
// do pg-boss ligados, embedder falso por DI.
describe('monthly AI budget (e2e)', () => {
  let app: INestApplication;
  let account: ClientAccount;
  const embedder = new FakeEmbedder();
  const c = identityClient(() => app);
  const hub = simulatedHub(() => app);
  const cloud = cloudSwitch(() => app);

  let finance: { userId: string; token: string };
  let support: { userId: string; token: string };
  let platformAdmin: { userId: string; token: string };
  let owner: KeyedUser;
  let member: KeyedUser;
  let stranger: KeyedUser;
  let orgId: string;
  let spaceId: string;

  const db = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await adminDataSource()).query(sql, params);
  const putBudget = (token: string, org: string, body: unknown) =>
    request(app.getHttpServer())
      .put(`/platform/organizations/${org}/ai-budget`)
      .set({ Authorization: `Bearer ${token}` })
      .send(body as object);
  const budgetBody = (budgetMicroUsd: number) => ({
    budgetMicroUsd,
    reason: 'plan upgrade, invoice 42',
    currentAuthProof: account.authProof,
  });
  const usage = (u: { token: string }, org = orgId) =>
    request(app.getHttpServer())
      .get(`/organizations/${org}/ai-usage`)
      .set({ Authorization: `Bearer ${u.token}` });
  const orgView = async (u: { token: string }, org = orgId) =>
    (
      await request(app.getHttpServer())
        .get(`/organizations/${org}`)
        .set({ Authorization: `Bearer ${u.token}` })
        .expect(200)
    ).body;
  const budget = () => app.get(AiBudget);
  const req = (estimatedMicroUsd: bigint, org = orgId, space = spaceId) => ({
    organizationId: org,
    spaceId: space,
    kind: 'answer' as const,
    estimatedMicroUsd,
  });
  const resetLedger = async () => {
    await db(`DELETE FROM cloud_ai_reservations`);
    await db(`DELETE FROM cloud_ai_usage`);
  };

  const eventually = async (check: () => Promise<void>, timeoutMs = 30_000) => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      try {
        await check();
        return;
      } catch (error) {
        if (Date.now() > until) throw error;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  };

  beforeAll(async () => {
    await sodium.ready;
    await resetDatabase();
    app = await createTestApp({
      env: { JOB_WORKERS_ENABLED: 'true' },
      overrides: [{ provide: Embedder, useValue: embedder }],
    });
    account = await createClientAccount(PASSWORD);
    finance = await c.signUp(account, 'finance@example.com', 'Fin');
    support = await c.signUp(account, 'support@example.com', 'Sup');
    platformAdmin = await c.signUp(account, 'padmin@example.com', 'Adm');
    await grantRoleInDb(finance.userId, 'platform_finance');
    await grantRoleInDb(support.userId, 'platform_support');
    await grantRoleInDb(platformAdmin.userId, 'platform_admin');
    owner = await c.spaces.signUpKeyed('owner@example.com', 'Owner');
    member = await c.spaces.signUpKeyed('member@example.com', 'Member');
    stranger = await c.spaces.signUpKeyed('stranger@example.com', 'Str');
    const org = await c.spaces.orgWithKit(owner);
    orgId = org.orgId;
    await c.spaces.joinOrg(owner, orgId, member);
    const created = await c.spaces.create(owner, orgId, org.kit.publicKey);
    expect(created.res.status).toBe(201);
    spaceId = created.spaceId;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  describe('finance adjusts the budget', () => {
    it('finance sets it (micro-USD): 200, both trails record it, the organization starts at 0', async () => {
      expect((await orgView(owner)).ai).toEqual({
        budgetConfigured: false,
        warningLevel: 100,
      });
      const res = await expectStatus(
        putBudget(finance.token, orgId, budgetBody(5_000_000)),
        200,
      );
      expect(res.body).toEqual({
        organizationId: orgId,
        fromMicroUsd: 0,
        toMicroUsd: 5_000_000,
      });
      const platform = (await platformAuditRows()).filter(
        (r) => r.action === 'platform.organization.ai_budget_changed',
      );
      expect(platform).toHaveLength(1);
      expect(platform[0]).toMatchObject({
        user_id: finance.userId,
        result: 'success',
        metadata: {
          from: 0,
          to: 5_000_000,
          reason: 'plan upgrade, invoice 42',
        },
      });
      const rows = await auditRows(orgId, 'organization.ai_budget_changed');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        user_id: null,
        metadata: { actor: 'platform', fromMicroUsd: 0, toMicroUsd: 5_000_000 },
      });
      expect(JSON.stringify(rows[0]!.metadata)).not.toContain(finance.userId);
      expect((await orgView(member)).ai).toEqual({
        budgetConfigured: true,
        warningLevel: 0,
      });
    });

    it('the platform admin may too; support, the organization owner and a stranger get 404', async () => {
      await expectStatus(
        putBudget(platformAdmin.token, orgId, budgetBody(6_000_000)),
        200,
      );
      await putBudget(support.token, orgId, budgetBody(1)).expect(404);
      await putBudget(owner.token, orgId, budgetBody(1)).expect(404);
      await putBudget(stranger.token, orgId, budgetBody(1)).expect(404);
      const [{ b }] = await db<{ b: string }>(
        `SELECT ai_budget_micro_usd::text AS b FROM organizations WHERE id = $1`,
        [orgId],
      );
      expect(b).toBe('6000000');
    });

    it('unknown organization 404; malformed id, negative, missing reason, wrong proof: 422; 0 is allowed', async () => {
      await putBudget(finance.token, MISSING_ID, budgetBody(1)).expect(404);
      await putBudget(finance.token, 'nope', budgetBody(1)).expect(422);
      await putBudget(finance.token, orgId, budgetBody(-1)).expect(422);
      await putBudget(finance.token, orgId, {
        ...budgetBody(1),
        reason: '',
      }).expect(422);
      await putBudget(finance.token, orgId, {
        ...budgetBody(1),
        currentAuthProof: 'AAAA',
      }).expect(422);
      await expectStatus(putBudget(finance.token, orgId, budgetBody(0)), 200);
      await setAiBudgetInDb(orgId, 6_000_000);
    });
  });

  describe('reservations and usage', () => {
    beforeEach(async () => {
      await resetLedger();
      await setAiBudgetInDb(orgId, 1000);
    });

    it('concurrent reservations never add up beyond the budget', async () => {
      const outcomes = await Promise.allSettled(
        Array.from({ length: 25 }, () => budget().reserve(req(100n))),
      );
      const ok = outcomes.filter((o) => o.status === 'fulfilled');
      const refused = outcomes.filter((o) => o.status === 'rejected');
      expect(ok).toHaveLength(10);
      expect(refused).toHaveLength(15);
      for (const r of refused) {
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(
          AiBudgetExceededError,
        );
      }
      const [{ total }] = await db<{ total: string }>(
        `SELECT COALESCE(SUM(amount_micro_usd), 0)::text AS total FROM cloud_ai_reservations
          WHERE organization_id = $1 AND status = 'reserved'`,
        [orgId],
      );
      expect(total).toBe('1000');
    });

    it('settle records the real spend by space and kind; release frees the reservation; the ledger has no content', async () => {
      const a = await budget().reserve(req(600n));
      await expect(budget().reserve(req(500n))).rejects.toMatchObject({
        code: 'ai-budget-exceeded',
      });
      await budget().settle(a, {
        model: 'fake-llm',
        inputTokens: 100,
        outputTokens: 50,
        costMicroUsd: 350n,
      });
      // Idempotent: a second settle or a release after it writes nothing.
      await budget().settle(a, {
        model: 'fake-llm',
        inputTokens: 100,
        outputTokens: 50,
        costMicroUsd: 350n,
      });
      await budget().release(a);
      const b = await budget().reserve({
        ...req(400n),
        kind: 'indexing',
      });
      await budget().release(b);
      const view = await expectStatus(usage(owner), 200);
      expect(view.body).toMatchObject({
        organizationId: orgId,
        budgetMicroUsd: 1000,
        spentMicroUsd: 350,
        reservedMicroUsd: 0,
        remainingMicroUsd: 650,
        warningLevel: 0,
        items: [
          {
            spaceId,
            kind: 'answer',
            costMicroUsd: 350,
            inputTokens: 100,
            outputTokens: 50,
            calls: 1,
          },
        ],
      });
      expect(view.body.month).toMatch(/^\d{4}-\d{2}$/);
      const resetsAt = new Date(view.body.resetsAt);
      expect(resetsAt.getUTCDate()).toBe(1);
      expect(resetsAt.getUTCHours()).toBe(0);
      expect(resetsAt.getTime()).toBeGreaterThan(Date.now());
      const statuses = await db<{ status: string }>(
        `SELECT status FROM cloud_ai_reservations WHERE organization_id = $1 ORDER BY created_at, id`,
        [orgId],
      );
      expect(statuses.map((s) => s.status)).toEqual(['settled', 'released']);
    });

    it('warning levels 75 / 90 / 100 in the usage view and in the organization (every member, no amounts)', async () => {
      const spend = async (cost: bigint) => {
        const r = await budget().reserve(req(cost));
        await budget().settle(r, {
          model: 'fake-llm',
          inputTokens: 1,
          outputTokens: 1,
          costMicroUsd: cost,
        });
      };
      await spend(750n);
      expect((await expectStatus(usage(owner), 200)).body.warningLevel).toBe(
        75,
      );
      expect((await orgView(member)).ai).toEqual({
        budgetConfigured: true,
        warningLevel: 75,
      });
      await spend(150n);
      expect((await orgView(member)).ai.warningLevel).toBe(90);
      await spend(100n);
      expect((await expectStatus(usage(owner), 200)).body).toMatchObject({
        warningLevel: 100,
        remainingMicroUsd: 0,
      });
      expect((await orgView(member)).ai.warningLevel).toBe(100);
      // An answer now: 422 ai-budget-exceeded (nothing runs).
      await expect(budget().reserve(req(1n))).rejects.toBeInstanceOf(
        AiBudgetExceededError,
      );
    });

    it('a forgotten reservation stops counting when it expires; a late settle still records the spend', async () => {
      const r = await budget().reserve(req(1000n));
      await expect(budget().reserve(req(1n))).rejects.toBeInstanceOf(
        AiBudgetExceededError,
      );
      await db(
        `UPDATE cloud_ai_reservations SET expires_at = now() - interval '1 second' WHERE id = $1`,
        [r.id],
      );
      const next = await budget().reserve(req(1n));
      const [{ status }] = await db<{ status: string }>(
        `SELECT status FROM cloud_ai_reservations WHERE id = $1`,
        [r.id],
      );
      expect(status).toBe('expired');
      await budget().release(next);
      await budget().settle(r, {
        model: 'fake-llm',
        inputTokens: 1,
        outputTokens: 1,
        costMicroUsd: 900n,
      });
      expect((await expectStatus(usage(owner), 200)).body).toMatchObject({
        spentMicroUsd: 900,
        reservedMicroUsd: 0,
      });
    });

    it('the usage view: admins only (member 403, stranger 404, malformed 422)', async () => {
      await usage(member).expect(403);
      await usage(stranger).expect(404);
      await usage(owner, 'nope').expect(422);
      await usage(owner, MISSING_ID).expect(404);
    });
  });

  describe('indexing stops at the next batch and resumes when finance raises the budget (Review Focus 3)', () => {
    it('pauses with the spend recorded and a resume scheduled for next month; a raise resumes it now', async () => {
      await resetLedger();
      const ana = await c.spaces.signUpKeyed('ana@example.com', 'Ana');
      const anaOrg = await c.spaces.orgWithKit(ana);
      const created = await c.spaces.create(
        ana,
        anaOrg.orgId,
        anaOrg.kit.publicKey,
      );
      const space = { spaceId: created.spaceId, key: created.key };
      // 4 batches of embeddings; the budget fits exactly 2 (the 3rd reservation does not fit).
      const text = Array.from({ length: 12_000 }, (_, i) => `termo${i}`).join(
        ' ',
      );
      const pieces = chunkText(text);
      expect(Math.ceil(pieces.length / EMBEDDING_BATCH)).toBeGreaterThanOrEqual(
        3,
      );
      const pricing = new AiPricing();
      const batch = (n: number) =>
        pieces.slice(n * EMBEDDING_BATCH, (n + 1) * EMBEDDING_BATCH);
      const actual = (n: number) =>
        pricing.costMicroUsd(
          {
            inputTokens: batch(n).reduce(
              (s, t) => s + Math.ceil(t.length / 4),
              0,
            ),
            outputTokens: 0,
          },
          FAKE_EMBEDDING_MODEL,
        );
      const estimate = (n: number) =>
        pricing.costMicroUsd(
          { inputTokens: estimateEmbeddingTokens(batch(n)), outputTokens: 0 },
          FAKE_EMBEDDING_MODEL,
        );
      const limit = actual(0) + actual(1) + estimate(2) - 1n;
      expect(actual(0) + estimate(1)).toBeLessThanOrEqual(limit);
      await setAiBudgetInDb(anaOrg.orgId, Number(limit));

      const sim = hub.forSpace(ana, space);
      const { fileId } = await sim.addFile(
        'Manual grande.txt',
        'text/plain',
        enc(text),
      );
      await cloud.switchOn(ana, anaOrg.orgId, space.spaceId, [space.key]);

      const usageRow = () =>
        db<{ calls: number; cost: string }>(
          `SELECT calls, cost_micro_usd::text AS cost FROM cloud_ai_usage
            WHERE space_id = $1 AND kind = 'indexing'`,
          [space.spaceId],
        );
      const fileRow = async () =>
        (
          await db<{ status: string; chunk_count: number }>(
            `SELECT status, chunk_count FROM cloud_files WHERE space_id = $1 AND file_id = $2`,
            [space.spaceId, fileId],
          )
        )[0];
      const resumeJob = () =>
        db<{ state: string; start_after: Date }>(
          `SELECT state, start_after FROM pgboss.job
            WHERE name = 'cloud.index-space' AND singleton_key = $1 AND state = 'created'`,
          [`space-resume:${space.spaceId}`],
        );

      // Paused: 2 batches spent and recorded, the file still pending, no chunk, the resume waiting for next month.
      await eventually(async () => {
        expect(await resumeJob()).toHaveLength(1);
      });
      const [paused] = await usageRow();
      expect(paused).toEqual({
        calls: 2,
        cost: (actual(0) + actual(1)).toString(),
      });
      expect(await fileRow()).toEqual({ status: 'pending', chunk_count: 0 });
      const [job] = await resumeJob();
      const nextMonth = new Date();
      nextMonth.setUTCDate(1);
      nextMonth.setUTCHours(0, 0, 0, 0);
      nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
      expect(new Date(job!.start_after).getTime()).toBeGreaterThanOrEqual(
        nextMonth.getTime(),
      );
      const anaUsage = await expectStatus(usage(ana, anaOrg.orgId), 200);
      expect(anaUsage.body.items).toEqual([
        expect.objectContaining({
          spaceId: space.spaceId,
          kind: 'indexing',
          calls: 2,
        }),
      ]);

      // Finance raises it: the indexing resumes now and finishes.
      await expectStatus(
        putBudget(finance.token, anaOrg.orgId, budgetBody(100_000_000)),
        200,
      );
      await eventually(async () => {
        expect(await fileRow()).toEqual({
          status: 'indexed',
          chunk_count: pieces.length,
        });
      });
      const [done] = await usageRow();
      // The paused file starts over (its first batches were not kept): 2 + every batch.
      expect(done!.calls).toBe(2 + Math.ceil(pieces.length / EMBEDDING_BATCH));
      // Nothing legible in the ledger: ids, kinds, models, counts and costs only.
      const ledgerText = JSON.stringify(
        await db(`SELECT * FROM cloud_ai_reservations`),
      );
      expect(ledgerText).not.toContain('termo1');
      expect(ledgerText).not.toContain('Manual grande');
    }, 120_000);
  });
});
