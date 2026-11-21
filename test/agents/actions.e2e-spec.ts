import type { INestApplication } from '@nestjs/common';
import { newId } from '../../src/shared/domain/id.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import {
  conversationsKit,
  hubRecipientOf,
} from '../support/conversations-kit.js';
import { hubClient } from '../support/hub-client.js';
import { hubsKit, type ClaimedHub } from '../support/hubs-kit.js';
import {
  expectStatus,
  identityClient,
  recipientOf,
  type KeyedUser,
} from '../support/identity-client.js';

const GiB = 1024 ** 3;

type Row = {
  action_id: string;
  hub_id: string;
  organization_id: string;
  space_id: string;
  owner_user_id: string;
  conversation_id: string;
  message_id: string;
  tool_name: string;
  effect: string;
  decision: string;
  duration_ms: number;
  policy_version: number;
};

// Auditoria das ações do agente (spec pc-agent §5.6) pela HTTP real, com o papel de runtime (RLS valendo).
describe('agent action audit (e2e)', () => {
  let app: INestApplication;
  const c = identityClient(() => app);
  const s = c.spaces;
  const h = hubClient(() => app);
  const hubs = hubsKit(() => app);
  const k = conversationsKit(() => app);
  let olivia: KeyedUser; // org admin, owner of the pc
  let ana: KeyedUser; // member, owner of the other pc
  let orgId: string;
  let spaceId: string;
  let pc: ClaimedHub; // olivia's agent
  let otherPc: ClaimedHub; // ana's agent
  let convOfPc: string; // executed by `pc`
  let convOfOtherPc: string; // executed by `otherPc`

  const item = (over: Record<string, unknown> = {}) => ({
    id: newId(),
    conversationId: convOfPc,
    messageId: newId(),
    toolName: 'mcp:github/create_issue',
    effect: 'allow',
    decision: 'executed',
    startedAt: '2026-11-21T10:00:00.000Z',
    durationMs: 120,
    policyVersion: 3,
    ...over,
  });
  const post = async (hub: ClaimedHub, body: unknown) => {
    const token = await h.authenticate(hub);
    return c
      .http()
      .post('/hub/agent/actions')
      .set({ Authorization: `Bearer ${token}` })
      .send(body as object);
  };
  const rows = async (): Promise<Row[]> =>
    (await adminDataSource()).query(
      `SELECT * FROM agent_action_logs ORDER BY created_at, id`,
    );
  const orgList = (token: string, query = '', org = orgId) =>
    c
      .http()
      .get(`/organizations/${org}/agent-actions${query}`)
      .set(c.bearer(token));
  const hubList = (token: string, hubId: string, query = '') =>
    c.http().get(`/hubs/${hubId}/agent/actions${query}`).set(c.bearer(token));

  const executedBy = async (user: KeyedUser, hub: ClaimedHub) => {
    const conv = await k.create(user, spaceId, {
      executor: hubRecipientOf(hub),
    });
    await expectStatus(Promise.resolve(conv.res), 201);
    return conv.id;
  };

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    olivia = await s.signUpKeyed('olivia@example.com', 'Olivia');
    ana = await s.signUpKeyed('ana@example.com', 'Ana');
    const o = await s.orgWithKit(olivia, 'Agentes');
    orgId = o.orgId;
    await s.joinOrg(olivia, orgId, ana);
    pc = await h.onboard(olivia.token, 'PC da Olivia', { kind: 'pc' });
    otherPc = await h.onboard(ana.token, 'PC da Ana', { kind: 'pc' });
    await hubs.link(olivia, pc.hubId, orgId);
    const al = await hubs.link(ana, otherPc.hubId, orgId);
    if (al.status !== 'approved')
      await hubs.approve(olivia, otherPc.hubId, orgId);
    const sp = await s.create(olivia, orgId, o.kit.publicKey, 'Projetos', {
      storageQuotaBytes: GiB,
    });
    await expectStatus(Promise.resolve(sp.res), 201);
    spaceId = sp.spaceId;
    await expectStatus(
      s.addMember(
        olivia.token,
        spaceId,
        recipientOf(ana),
        [sp.key],
        'space_editor',
      ),
      201,
    );
    await hubs.addSpace(olivia, pc.hubId, spaceId);
    await hubs.addSpace(ana, otherPc.hubId, spaceId);
    convOfPc = await executedBy(olivia, pc);
    convOfOtherPc = await executedBy(ana, otherPc);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  });

  it('the same id twice records once; the same id with other content is 409 agent-action-id-conflict', async () => {
    const a = item();
    const first = await expectStatus(post(pc, { items: [a] }), 200);
    expect(first.body).toEqual({ recorded: 1 });
    // The agent lost the answer and resends the same thing (and repeats it inside the batch too).
    const again = await expectStatus(post(pc, { items: [a, a] }), 200);
    expect(again.body).toEqual({ recorded: 0 });
    expect((await rows()).filter((r) => r.action_id === a.id)).toHaveLength(1);

    const other = item({ id: a.id, decision: 'failed' });
    const res = await post(pc, { items: [item(), other] });
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/\/agent-action-id-conflict$/);
    const inBatch = await post(pc, {
      items: [item({ id: a.id, durationMs: 1 }), item({ id: a.id })],
    });
    expect(inBatch.status).toBe(409);
    // The conflicting batch wrote nothing, not even its valid item.
    expect((await rows()).filter((r) => r.action_id !== a.id)).toHaveLength(0);
  });

  it('refuses more than 100 items and unknown fields (no argument or result gets through)', async () => {
    const before = (await rows()).length;
    const many = Array.from({ length: 101 }, () => item());
    expect((await post(pc, { items: many })).status).toBe(422);
    expect((await post(pc, { items: [] })).status).toBe(422);
    for (const extra of [
      { arguments: { title: 'segredo' } },
      { result: 'texto' },
      { path: 'C:\\Users\\x' },
      { url: 'https://example.com' },
      { organizationId: orgId },
    ]) {
      const res = await post(pc, { items: [item(extra)] });
      expect(res.status).toBe(422);
    }
    expect(
      (await post(pc, { items: [item({ effect: 'maybe' })] })).status,
    ).toBe(422);
    expect(
      (await post(pc, { items: [item({ decision: 'ignored' })] })).status,
    ).toBe(422);
    expect((await post(pc, { items: [item({ durationMs: -1 })] })).status).toBe(
      422,
    );
    expect((await rows()).length).toBe(before);
    // exactly 100 is fine
    const hundred = Array.from({ length: 100 }, () => item());
    const ok = await expectStatus(post(pc, { items: hundred }), 200);
    expect(ok.body).toEqual({ recorded: 100 });
  });

  it("the organization is the one of the conversation's space, read by the server", async () => {
    const a = item();
    await expectStatus(post(pc, { items: [a] }), 200);
    const row = (await rows()).find((r) => r.action_id === a.id)!;
    expect(row).toMatchObject({
      hub_id: pc.hubId,
      organization_id: orgId,
      space_id: spaceId,
      owner_user_id: olivia.userId,
      conversation_id: convOfPc,
      message_id: a.messageId,
      tool_name: 'mcp:github/create_issue',
      effect: 'allow',
      decision: 'executed',
      duration_ms: 120,
      policy_version: 3,
    });

    // A conversation the hub does not execute (or that does not exist): 404 for the whole batch, nothing written.
    const before = (await rows()).length;
    for (const conversationId of [convOfOtherPc, newId()]) {
      const res = await post(pc, {
        items: [item(), item({ conversationId })],
      });
      expect(res.status).toBe(404);
      expect(res.body.type).toMatch(/\/conversation-not-found$/);
    }
    expect((await rows()).length).toBe(before);
  });

  it('an appliance gets the Nest unknown-route 404', async () => {
    const appliance = await h.onboard(olivia.token, 'Casa');
    const res = await post(appliance, { items: [item()] });
    expect(res.status).toBe(404);
    expect(res.body.detail ?? res.body.message).toMatch(
      /Cannot POST \/hub\/agent\/actions/,
    );
  });

  it('is append-only for the runtime role', async () => {
    const ds = await adminDataSource();
    const [r] = (await ds.query(
      `SELECT has_table_privilege('app_runtime', 'agent_action_logs', 'SELECT') AS sel,
              has_table_privilege('app_runtime', 'agent_action_logs', 'INSERT') AS ins,
              has_table_privilege('app_runtime', 'agent_action_logs', 'UPDATE') AS upd,
              has_table_privilege('app_runtime', 'agent_action_logs', 'DELETE') AS del`,
    )) as [Record<string, boolean>];
    expect(r).toEqual({ sel: true, ins: true, upd: false, del: false });
  });

  describe('reads', () => {
    beforeAll(async () => {
      // Ana's agent reports too, so the filters have something to filter.
      await expectStatus(
        post(otherPc, {
          items: [
            item({ conversationId: convOfOtherPc, toolName: 'browser:open' }),
            item({
              conversationId: convOfOtherPc,
              toolName: 'folder:read',
              decision: 'blocked',
              effect: 'deny',
            }),
          ],
        }),
        200,
      );
    });

    it('GET /organizations/:orgId/agent-actions needs org.agents.manage and filters by userId and hubId with a cursor', async () => {
      expect((await orgList(ana.token)).status).toBe(403);
      const outsider = await s.signUpKeyed('zed@example.com', 'Zed');
      expect((await orgList(outsider.token)).status).toBe(404);

      const collect = async (query: string, size = 50) => {
        const out: Record<string, unknown>[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const q: string = `?limit=${size}${query}${cursor ? `&cursor=${cursor}` : ''}`;
          const page = await expectStatus(orgList(olivia.token, q), 200);
          out.push(...page.body.items);
          cursor = page.body.nextCursor;
          pages += 1;
        } while (cursor);
        return { items: out, pages };
      };
      const total = (await rows()).length;
      const all = await collect('');
      expect(all.items).toHaveLength(total);
      expect(all.pages).toBe(Math.ceil(total / 50));
      expect(all.items[0]).toEqual({
        id: expect.any(String),
        hubId: expect.any(String),
        userId: expect.any(String),
        spaceId,
        conversationId: expect.any(String),
        messageId: expect.any(String),
        toolName: expect.any(String),
        effect: expect.any(String),
        decision: expect.any(String),
        startedAt: expect.any(String),
        durationMs: expect.any(Number),
        policyVersion: expect.any(Number),
        recordedAt: expect.any(String),
      });
      // Newest first, no repeats across pages.
      const ids = all.items.map((i) => i.id as string);
      expect(new Set(ids).size).toBe(total);

      const byUser = await collect(`&userId=${ana.userId}`);
      expect(byUser.items).toHaveLength(2);
      expect(byUser.items.every((i) => i.userId === ana.userId)).toBe(true);
      const byHub = await collect(`&hubId=${pc.hubId}`);
      expect(byHub.items).toHaveLength(total - 2);
      expect(byHub.items.every((i) => i.hubId === pc.hubId)).toBe(true);
      const both = await collect(`&hubId=${pc.hubId}&userId=${ana.userId}`);
      expect(both.items).toEqual([]);

      const first = await expectStatus(orgList(olivia.token, '?limit=1'), 200);
      expect(first.body.items).toHaveLength(1);
      expect(first.body.items[0].id).toBe(ids[0]);
      expect(first.body.nextCursor).toEqual(expect.any(String));
      expect((await orgList(olivia.token, '?cursor=xx')).status).toBe(422);
      expect((await orgList(olivia.token, '?userId=nope')).status).toBe(422);
    });

    it('a session opened through a hub never reads the audit of the organization (same 404 as an outsider)', async () => {
      const login = await expectStatus(
        h.loginPerson(
          await h.authenticate(pc),
          olivia.email,
          olivia.account.authProof,
        ),
        200,
      );
      const res = await orgList(login.body.session.accessToken as string);
      expect(res.status).toBe(404);
      expect(res.body.type).toMatch(/\/organization-not-found$/);
    });

    it('GET /hubs/:id/agent/actions is owner only', async () => {
      const mine = await expectStatus(
        hubList(olivia.token, pc.hubId, '?limit=100'),
        200,
      );
      expect(mine.body.items.length).toBeGreaterThan(0);
      expect(
        mine.body.items.every((i: { hubId: string }) => i.hubId === pc.hubId),
      ).toBe(true);
      // Not the owner (even an admin of the organization), and an appliance: the same 404.
      const asAna = await hubList(ana.token, pc.hubId);
      expect(asAna.status).toBe(404);
      expect(asAna.body.type).toMatch(/\/hub-not-found$/);
      const appliance = await h.onboard(olivia.token, 'Outra casa');
      expect((await hubList(olivia.token, appliance.hubId)).status).toBe(404);
      expect((await hubList(olivia.token, newId())).status).toBe(404);
      const page = await expectStatus(
        hubList(olivia.token, pc.hubId, '?limit=2'),
        200,
      );
      expect(page.body.items).toHaveLength(2);
      expect(page.body.nextCursor).toEqual(expect.any(String));
    });
  });
});
