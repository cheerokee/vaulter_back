import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Response } from 'supertest';
import { AgentLeaseSweepJob } from '../../src/conversations/application/agent-lease-sweep.job.js';
import { AgentTurn } from '../../src/conversations/application/agent-turn.js';
import { CloudConversationExecutor } from '../../src/conversations/application/cloud-conversation-executor.js';
import { AGENT_ACK_LEASE_MS } from '../../src/conversations/domain/conversation-limits.js';
import {
  CloudReservePendingHooks,
  type CloudReservePendingContext,
} from '../../src/shared/application/cloud-reserve-pending-hooks.js';
import { DataSource } from 'typeorm';
import { runWithContext } from '../../src/shared/infra/db/unit-of-work.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
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
import { cloudSwitch } from '../support/space-manifest.js';

function expectProblem(res: Response, status: number, type: string): void {
  if (res.status !== status || !String(res.body.type).endsWith(`/${type}`)) {
    throw new Error(
      `expected ${status} ${type}, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }
}

type LeaseRow = {
  pending: boolean;
  acked_at: Date | null;
  acked_by_hub_id: string | null;
  acked_by_cloud: boolean;
  acked_lease_until: Date | null;
  requeued_at: Date | null;
};

// Prazo do ack do agente do PC (spec pc-agent §5.3, "Prazo do ack do agente"; Task 9 do plano), pela HTTP real, com a
// cifra real e o papel de runtime (RLS valendo). O prazo vence movendo `acked_lease_until` para o passado no banco e
// chamando a varredura direto (os e2e rodam sem workers: o cron nunca dispara sozinho).
describe('conversations: the pc agent ack lease (e2e)', () => {
  let app: INestApplication;
  const c = identityClient(() => app);
  const s = c.spaces;
  const h = hubClient(() => app);
  const hubs = hubsKit(() => app);
  const k = conversationsKit(() => app);
  const cloud = cloudSwitch(() => app);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  let olivia: KeyedUser; // admin, Gestora do espaço, dona do PC e do aparelho
  let ana: KeyedUser; // editora do espaço
  let orgId: string;
  let spaceId: string;
  let spaceKeys: Uint8Array[];
  let pc: ClaimedHub;
  let pcToken: string;
  let casa: ClaimedHub; // aparelho (appliance)
  let casaToken: string;
  let serverPk: string;
  const signals: CloudReservePendingContext[] = [];

  const executor = () => app.get(CloudConversationExecutor);
  const turn = () => app.get(AgentTurn);
  const sweep = () => app.get(AgentLeaseSweepJob).run();

  const create = async (hub: ClaimedHub) => {
    const conv = await k.create(olivia, spaceId, {
      serverPublicKey: serverPk,
      executor: hubRecipientOf(hub),
    });
    await expectStatus(Promise.resolve(conv.res), 201);
    await expectStatus(
      k.share(olivia, spaceId, conv.id, [recipientOf(ana)], conv.keys),
      200,
    );
    return { id: conv.id, keys: conv.keys as ConversationKeys };
  };
  /** Ana asks; returns the message id. */
  const ask = async (conversationId: string, keys: ConversationKeys) => {
    const sent = await k.send(ana, spaceId, conversationId, keys);
    await expectStatus(Promise.resolve(sent.res), 201);
    return sent.id;
  };
  const lease = (token: string, conversationId: string, messageId: string) =>
    http()
      .post(`/hub/conversations/${conversationId}/messages/${messageId}/lease`)
      .set(bearer(token));
  const row = async (messageId: string): Promise<LeaseRow> =>
    (
      await (
        await adminDataSource()
      ).query(
        `SELECT pending, acked_at, acked_by_hub_id, acked_by_cloud, acked_lease_until, requeued_at
           FROM conversation_messages WHERE id = $1`,
        [messageId],
      )
    )[0] as LeaseRow;
  /** The lease ran out (database clock): moved into the past by the owner login. */
  const expire = async (messageId: string) => {
    await (
      await adminDataSource()
    ).query(
      `UPDATE conversation_messages SET acked_lease_until = now() - interval '1 second' WHERE id = $1`,
      [messageId],
    );
  };

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    app.get(CloudReservePendingHooks).register({
      name: 'test.agent-lease.signals',
      onPending: async (ctx) => {
        signals.push(ctx);
      },
    });
    olivia = await s.signUpKeyed('olivia@example.com', 'Olivia');
    ana = await s.signUpKeyed('ana@example.com', 'Ana');
    const o = await s.orgWithKit(olivia, 'Agente');
    orgId = o.orgId;
    await s.joinOrg(olivia, orgId, ana);
    pc = await h.onboard(olivia.token, 'PC da Olivia', { kind: 'pc' });
    casa = await h.onboard(olivia.token, 'Casa');
    for (const hub of [pc, casa]) await hubs.link(olivia, hub.hubId, orgId);
    const sp = await s.create(olivia, orgId, o.kit.publicKey, 'Projetos');
    await expectStatus(Promise.resolve(sp.res), 201);
    spaceId = sp.spaceId;
    spaceKeys = [sp.key];
    await expectStatus(
      s.addMember(
        olivia.token,
        spaceId,
        recipientOf(ana),
        spaceKeys,
        'space_editor',
      ),
      201,
    );
    for (const hub of [pc, casa])
      await hubs.addSpace(olivia, hub.hubId, spaceId);
    serverPk = await s.serverPublicKey(olivia.token);
    await cloud.switchOn(olivia, orgId, spaceId, spaceKeys);
    pcToken = await h.authenticate(pc);
    casaToken = await h.authenticate(casa);
  }, 240_000);

  afterAll(async () => {
    app?.get(CloudReservePendingHooks).unregister('test.agent-lease.signals');
    await app?.close();
  });

  beforeEach(() => {
    signals.length = 0;
  });

  it('an ack by a pc hub sets acked_lease_until = acked_at + 15 min; an appliance ack leaves it null', async () => {
    const byPc = await create(pc);
    const m1 = await ask(byPc.id, byPc.keys);
    await expectStatus(k.hubAck(pcToken, byPc.id, m1), 200);
    const r1 = await row(m1);
    expect(r1.acked_by_hub_id).toBe(pc.hubId);
    expect(r1.acked_lease_until!.getTime()).toBe(
      r1.acked_at!.getTime() + AGENT_ACK_LEASE_MS,
    );
    // The lease is internal: never in the response.
    const again = await expectStatus(k.hubAck(pcToken, byPc.id, m1), 200);
    expect(again.body).not.toHaveProperty('ackedLeaseUntil');

    const byCasa = await create(casa);
    const m2 = await ask(byCasa.id, byCasa.keys);
    await expectStatus(k.hubAck(casaToken, byCasa.id, m2), 200);
    const r2 = await row(m2);
    expect(r2.acked_by_hub_id).toBe(casa.hubId);
    expect(r2.acked_lease_until).toBeNull();
  });

  it('requireTurn: the view of the message the pc acked; a pending one or one acked by another hub is 409', async () => {
    const conv = await create(pc);
    const m = await ask(conv.id, conv.keys);
    await expect(
      turn().requireTurn(pc.hubId, conv.id, m),
    ).rejects.toMatchObject({ code: 'brain-step-not-owned' });
    await expectStatus(k.hubAck(pcToken, conv.id, m), 200);
    await expect(turn().requireTurn(pc.hubId, conv.id, m)).resolves.toEqual({
      organizationId: orgId,
      spaceId,
      conversationId: conv.id,
      messageId: m,
      authorUserId: ana.userId,
      hubOwnerUserId: olivia.userId,
      cloudReserve: true,
    });
    // Another hub (not the executor): the same 404 of an unknown conversation.
    await expect(
      turn().requireTurn(casa.hubId, conv.id, m),
    ).rejects.toMatchObject({ code: 'conversation-not-found' });
  });

  it('renewLease moves the lease to now + 15 min, only for the hub that acked (route: pc only, 200 { leaseUntil })', async () => {
    const conv = await create(pc);
    const m = await ask(conv.id, conv.keys);
    expectProblem(
      await lease(pcToken, conv.id, m),
      409,
      'brain-step-not-owned',
    );
    await expectStatus(k.hubAck(pcToken, conv.id, m), 200);
    const before = await row(m);
    const res = await expectStatus(lease(pcToken, conv.id, m), 200);
    const after = await row(m);
    expect(res.body).toEqual({
      leaseUntil: after.acked_lease_until!.toISOString(),
    });
    expect(after.acked_lease_until!.getTime()).toBeGreaterThan(
      before.acked_lease_until!.getTime(),
    );
    const [{ now }] = await (
      await adminDataSource()
    ).query(`SELECT clock_timestamp() AS now`);
    // now + 15 min, by the database clock (a few seconds of test latency).
    expect(
      Math.abs(
        after.acked_lease_until!.getTime() -
          ((now as Date).getTime() + AGENT_ACK_LEASE_MS),
      ),
    ).toBeLessThan(10_000);

    // An appliance gets the not-found of an unknown route (it cannot tell the route exists).
    const asAppliance = await lease(casaToken, conv.id, m);
    expect(asAppliance.status).toBe(404);
    expect(asAppliance.body.detail).toBe(
      `Cannot POST /hub/conversations/${conv.id}/messages/${m}/lease`,
    );
    // Lease run out (the sweep has not run yet): too late to renew.
    await expire(m);
    expectProblem(
      await lease(pcToken, conv.id, m),
      409,
      'brain-step-not-owned',
    );
  });

  it('the sweep requeues expired leases (pending, requeued_at new) and fires CloudReservePendingHooks; the stale agent then gets 409/404 like a hub that lost the message', async () => {
    const conv = await create(pc);
    const m = await ask(conv.id, conv.keys);
    const live = await ask(conv.id, conv.keys);
    await expectStatus(k.hubAck(pcToken, conv.id, m), 200);
    await expectStatus(k.hubAck(pcToken, conv.id, live), 200);
    await expire(m);
    signals.length = 0;

    const result = await sweep();
    expect(result.requeued).toBeGreaterThanOrEqual(1);
    const r = await row(m);
    expect(r).toMatchObject({
      pending: true,
      acked_at: null,
      acked_by_hub_id: null,
      acked_lease_until: null,
    });
    expect(r.requeued_at).not.toBeNull();
    // Only the expired one: the message still within its lease stays the agent's.
    expect(await row(live)).toMatchObject({
      pending: false,
      acked_by_hub_id: pc.hubId,
    });
    // The cloud reserve answers it at once (the pc already had its 15 min). (Other tests left expired leases too.)
    expect(signals.filter((x) => x.conversationId === conv.id)).toEqual([
      {
        organizationId: orgId,
        spaceId,
        conversationId: conv.id,
        messageId: m,
        reason: 'requeued',
        immediate: true,
      },
    ]);

    // The stale agent: its next step and its renewal are 409 brain-step-not-owned...
    await expect(
      turn().requireTurn(pc.hubId, conv.id, m),
    ).rejects.toMatchObject({ code: 'brain-step-not-owned' });
    expectProblem(
      await lease(pcToken, conv.id, m),
      409,
      'brain-step-not-owned',
    );
    // ...and once the cloud took it, its ack is 404 message-not-found (discard, never run).
    expect(await executor().ack(orgId, spaceId, conv.id, m)).toBe('acked');
    expectProblem(
      await k.hubAck(pcToken, conv.id, m),
      404,
      'message-not-found',
    );
    await expect(
      turn().requireTurn(pc.hubId, conv.id, m),
    ).rejects.toMatchObject({ code: 'brain-step-not-owned' });

    // Running again changes nothing (idempotent).
    signals.length = 0;
    expect(await sweep()).toEqual({
      conversations: 0,
      requeued: 0,
      skipped: 0,
    });
    expect(signals).toEqual([]);
    expect((await row(m)).acked_by_cloud).toBe(true);
  });

  it('the sweep never touches a message the executor already answered', async () => {
    const conv = await create(pc);
    const m = await ask(conv.id, conv.keys);
    await expectStatus(k.hubAck(pcToken, conv.id, m), 200);
    const answer = await k.hubSend(pcToken, spaceId, conv.id, conv.keys);
    await expectStatus(Promise.resolve(answer.res), 201);
    const acked = await row(m);
    await expire(m);
    signals.length = 0;

    await sweep();
    const r = await row(m);
    expect(r).toMatchObject({
      pending: false,
      acked_by_hub_id: pc.hubId,
      acked_by_cloud: false,
      requeued_at: null,
    });
    expect(r.acked_at).toEqual(acked.acked_at);
    expect(signals).toEqual([]);
  });

  it('the sweep context reads only the message rows under a lease (no conversation, no other message)', async () => {
    const conv = await create(pc);
    const m = await ask(conv.id, conv.keys);
    const other = await ask(conv.id, conv.keys);
    await expectStatus(k.hubAck(pcToken, conv.id, m), 200);
    const asSweep = (sql: string) =>
      runWithContext(
        app.get(DataSource),
        { agentLeaseSweep: 'on' },
        (q) => q.query(sql) as Promise<Record<string, unknown>[]>,
      );
    const ids = (
      await asSweep(`SELECT id, acked_lease_until FROM conversation_messages`)
    ).map((r) => r.id);
    expect(ids).toContain(m);
    expect(ids).not.toContain(other);
    expect(await asSweep(`SELECT id FROM conversations`)).toEqual([]);
    expect(await asSweep(`SELECT id FROM conversation_key_grants`)).toEqual([]);
  });

  it('the executor change clears the leases of the hub that leaves (answered messages included)', async () => {
    const conv = await create(pc);
    const m = await ask(conv.id, conv.keys);
    await expectStatus(k.hubAck(pcToken, conv.id, m), 200);
    const answer = await k.hubSend(pcToken, spaceId, conv.id, conv.keys);
    await expectStatus(Promise.resolve(answer.res), 201);
    expect((await row(m)).acked_lease_until).not.toBeNull();
    // The pc loses the space: it stops being the executor (`requeueAckedBy`).
    await hubs.removeSpace(olivia, pc.hubId, spaceId);
    expect(await row(m)).toMatchObject({
      pending: false,
      acked_by_hub_id: pc.hubId,
      acked_lease_until: null,
    });
  });
});
