import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Response } from 'supertest';
import { BrainComposer } from '../../src/cloud/application/brain/brain-step.use-case.js';
import { BRAIN_STEP_BODY_MAX_BYTES } from '../../src/shared/infra/http/body-limits.js';
import {
  BRAIN_BODY_MAX_BYTES,
  BRAIN_MAX_CALLS,
  BRAIN_TOOL_RESULT_MAX_BYTES,
  type BrainStepRequest,
  type BrainStepResponse,
} from '../../src/cloud/domain/brain-step.js';
import type { AgentTurnView } from '../../src/conversations/application/agent-turn.js';
import { AgentLeaseSweepJob } from '../../src/conversations/application/agent-lease-sweep.job.js';
import { AGENT_ACK_LEASE_MS } from '../../src/conversations/domain/conversation-limits.js';
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

/** The composer (Task 11) replaced by DI: records what it got and answers a fixed `final`. */
class FakeBrainComposer extends BrainComposer {
  readonly calls: { view: AgentTurnView; request: BrainStepRequest }[] = [];
  response: BrainStepResponse = {
    kind: 'final',
    text: 'resposta',
    policyVersion: 0,
  };

  compose(
    view: AgentTurnView,
    req: BrainStepRequest,
  ): Promise<BrainStepResponse> {
    this.calls.push({ view, request: req });
    return Promise.resolve(this.response);
  }
}

// Passo do cérebro do agente do PC (spec pc-agent §5.3; Task 10 do plano): a rota e as checagens 1 -> 5 antes de
// qualquer custo, o contador de chamadas por mensagem e a renovação do prazo do ack. A composição (prompt, RAG, modelo,
// orçamento) é da Task 11: aqui um falso por DI. HTTP real, cifra real, papel de runtime (RLS valendo).
describe('cloud: the pc agent brain step (e2e)', () => {
  let app: INestApplication;
  const c = identityClient(() => app);
  const s = c.spaces;
  const h = hubClient(() => app);
  const hubs = hubsKit(() => app);
  const k = conversationsKit(() => app);
  const cloud = cloudSwitch(() => app);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const composer = new FakeBrainComposer();

  let olivia: KeyedUser; // admin, Gestora dos espaços, dona dos PCs e do aparelho
  let ana: KeyedUser; // editora dos espaços
  let orgId: string;
  let kitPublicKey: string;
  let spaceId: string; // nuvem ativa
  let pc: ClaimedHub;
  let pcToken: string;
  let casa: ClaimedHub; // aparelho
  let casaToken: string;
  let serverPk: string;

  const newSpace = async (name: string) => {
    const sp = await s.create(olivia, orgId, kitPublicKey, name);
    await expectStatus(Promise.resolve(sp.res), 201);
    await expectStatus(
      s.addMember(
        olivia.token,
        sp.spaceId,
        recipientOf(ana),
        [sp.key],
        'space_editor',
      ),
      201,
    );
    return { spaceId: sp.spaceId, keys: [sp.key] };
  };
  const create = async (
    hub: ClaimedHub,
    inSpace = spaceId,
    withReserve = true,
  ) => {
    const conv = await k.create(olivia, inSpace, {
      ...(withReserve ? { serverPublicKey: serverPk } : {}),
      executor: hubRecipientOf(hub),
    });
    await expectStatus(Promise.resolve(conv.res), 201);
    await expectStatus(
      k.share(olivia, inSpace, conv.id, [recipientOf(ana)], conv.keys),
      200,
    );
    return { id: conv.id, keys: conv.keys as ConversationKeys };
  };
  /** Ana asks in a conversation executed by `hub`, and the hub acks: the agent's turn. Returns the message id. */
  const turn = async (
    hub: ClaimedHub,
    token: string,
    conv: { id: string; keys: ConversationKeys },
    inSpace = spaceId,
  ) => {
    const sent = await k.send(ana, inSpace, conv.id, conv.keys);
    await expectStatus(Promise.resolve(sent.res), 201);
    await expectStatus(k.hubAck(token, conv.id, sent.id), 200);
    return sent.id;
  };
  const stepBody = (
    messageId: string,
    extra: Partial<BrainStepRequest> = {},
  ): BrainStepRequest => ({
    messageId,
    stepIndex: 0,
    history: [
      {
        id: messageId,
        author: 'person',
        authorUserId: ana.userId,
        text: 'Qual o prazo do contrato?',
      },
    ],
    turns: [],
    ...extra,
  });
  const step = (token: string, conversationId: string, body: unknown) =>
    http()
      .post(`/hub/conversations/${conversationId}/brain/step`)
      .set(bearer(token))
      .send(body as object);
  const db = async () => adminDataSource();
  const reservations = async () => {
    const [{ n }] = await (
      await db()
    ).query(
      `SELECT count(*)::int AS n FROM cloud_ai_reservations WHERE organization_id = $1`,
      [orgId],
    );
    return n as number;
  };
  const callsOf = async (messageId: string): Promise<number | null> => {
    const rows = await (
      await db()
    ).query(`SELECT calls FROM agent_brain_steps WHERE message_id = $1`, [
      messageId,
    ]);
    return rows.length ? (rows[0].calls as number) : null;
  };
  const leaseOf = async (messageId: string): Promise<Date | null> =>
    (
      await (
        await db()
      ).query(
        `SELECT acked_lease_until FROM conversation_messages WHERE id = $1`,
        [messageId],
      )
    )[0].acked_lease_until as Date | null;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp({
      overrides: [{ provide: BrainComposer, useValue: composer }],
    });
    olivia = await s.signUpKeyed('olivia@example.com', 'Olivia');
    ana = await s.signUpKeyed('ana@example.com', 'Ana');
    const o = await s.orgWithKit(olivia, 'Agente');
    orgId = o.orgId;
    kitPublicKey = o.kit.publicKey;
    await s.joinOrg(olivia, orgId, ana);
    pc = await h.onboard(olivia.token, 'PC da Olivia', { kind: 'pc' });
    casa = await h.onboard(olivia.token, 'Casa');
    for (const hub of [pc, casa]) await hubs.link(olivia, hub.hubId, orgId);
    const sp = await newSpace('Projetos');
    spaceId = sp.spaceId;
    for (const hub of [pc, casa])
      await hubs.addSpace(olivia, hub.hubId, spaceId);
    serverPk = await s.serverPublicKey(olivia.token);
    await cloud.switchOn(olivia, orgId, spaceId, sp.keys);
    pcToken = await h.authenticate(pc);
    casaToken = await h.authenticate(casa);
  }, 240_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    composer.calls.length = 0;
    composer.response = { kind: 'final', text: 'resposta', policyVersion: 0 };
  });

  it('an appliance hub gets the not-found of an unknown route', async () => {
    const conv = await create(casa);
    const m = await turn(casa, casaToken, conv);
    const res = await step(casaToken, conv.id, stepBody(m));
    expect(res.status).toBe(404);
    expect(res.body.detail).toBe(
      `Cannot POST /hub/conversations/${conv.id}/brain/step`,
    );
    expect(composer.calls).toEqual([]);
  });

  it('a successful step passes the turn view and the request to the composer, returns its answer and renews the ack lease', async () => {
    const conv = await create(pc);
    const m = await turn(pc, pcToken, conv);
    // The lease close to its end: the step moves it to now + 15 min (database clock).
    await (
      await db()
    ).query(
      `UPDATE conversation_messages SET acked_lease_until = now() + interval '1 minute' WHERE id = $1`,
      [m],
    );
    composer.response = {
      kind: 'tools',
      toolCalls: [
        {
          id: 't1',
          name: 'mcp:erp/consultar',
          input: { pedido: 42 },
          effect: 'allow',
        },
      ],
      policyVersion: 3,
    };
    const body = stepBody(m, { stepIndex: 2 });
    const res = await expectStatus(step(pcToken, conv.id, body), 200);
    expect(res.body).toEqual(composer.response);
    expect(composer.calls).toEqual([
      {
        view: {
          organizationId: orgId,
          spaceId,
          conversationId: conv.id,
          messageId: m,
          authorUserId: ana.userId,
          hubOwnerUserId: olivia.userId,
          cloudReserve: true,
        },
        request: body,
      },
    ]);
    const [{ now }] = await (
      await db()
    ).query(`SELECT clock_timestamp() AS now`);
    expect(
      Math.abs(
        (await leaseOf(m))!.getTime() -
          ((now as Date).getTime() + AGENT_ACK_LEASE_MS),
      ),
    ).toBeLessThan(10_000);
    expect(await callsOf(m)).toBe(1);
  });

  it('a hub that is not the executor gets 404 conversation-not-found', async () => {
    const other = await h.onboard(olivia.token, 'Notebook da Olivia', {
      kind: 'pc',
    });
    await hubs.link(olivia, other.hubId, orgId);
    await hubs.addSpace(olivia, other.hubId, spaceId);
    const otherToken = await h.authenticate(other);
    const conv = await create(pc);
    const m = await turn(pc, pcToken, conv);
    expectProblem(
      await step(otherToken, conv.id, stepBody(m)),
      404,
      'conversation-not-found',
    );
    expect(composer.calls).toEqual([]);
    expect(await callsOf(m)).toBeNull();
  });

  it('after the hub is unlinked mid-loop, the next step is 404 and reserves nothing', async () => {
    const lone = await h.onboard(olivia.token, 'PC do escritório', {
      kind: 'pc',
    });
    await hubs.link(olivia, lone.hubId, orgId);
    await hubs.addSpace(olivia, lone.hubId, spaceId);
    const loneToken = await h.authenticate(lone);
    const conv = await create(lone);
    const m = await turn(lone, loneToken, conv);
    await expectStatus(step(loneToken, conv.id, stepBody(m)), 200);
    // Vacuous until Task 11 (only the composer reserves): `composer.calls` empty and `callsOf(m)` are the real proof.
    const before = await reservations();

    await hubs.unlink(olivia, lone.hubId, orgId);
    composer.calls.length = 0;
    expectProblem(
      await step(loneToken, conv.id, stepBody(m, { stepIndex: 1 })),
      404,
      'conversation-not-found',
    );
    expect(composer.calls).toEqual([]);
    expect(await reservations()).toBe(before);
    expect(await callsOf(m)).toBe(1);
  });

  it('a space outside active_cloud is 422 cloud-not-active', async () => {
    const plain = await newSpace('Sem nuvem');
    await hubs.addSpace(olivia, pc.hubId, plain.spaceId);
    const conv = await create(pc, plain.spaceId, false);
    const m = await turn(pc, pcToken, conv, plain.spaceId);
    expectProblem(
      await step(pcToken, conv.id, stepBody(m)),
      422,
      'cloud-not-active',
    );
    // Check 2 comes before check 3: a message that is not the agent's turn is still 422 here, never 409.
    const unacked = await k.send(ana, plain.spaceId, conv.id, conv.keys);
    await expectStatus(Promise.resolve(unacked.res), 201);
    expectProblem(
      await step(pcToken, conv.id, stepBody(unacked.id)),
      422,
      'cloud-not-active',
    );
    expect(composer.calls).toEqual([]);
    expect(await callsOf(m)).toBeNull();
  });

  it('after deactivate mid-loop, 422 cloud-not-active, no reservation, and the lease still expires to the cloud reserve', async () => {
    const sp = await newSpace('Nuvem que desliga');
    await hubs.addSpace(olivia, pc.hubId, sp.spaceId);
    await cloud.switchOn(olivia, orgId, sp.spaceId, sp.keys);
    const conv = await create(pc, sp.spaceId);
    const m = await turn(pc, pcToken, conv, sp.spaceId);
    await expectStatus(step(pcToken, conv.id, stepBody(m)), 200);
    const leaseAfterStep = await leaseOf(m);
    // Vacuous until Task 11 (only the composer reserves): `composer.calls` empty and `callsOf(m)` are the real proof.
    const before = await reservations();

    await cloud.switchOff(olivia, sp.spaceId);
    composer.calls.length = 0;
    expectProblem(
      await step(pcToken, conv.id, stepBody(m, { stepIndex: 1 })),
      422,
      'cloud-not-active',
    );
    expect(composer.calls).toEqual([]);
    expect(await reservations()).toBe(before);
    expect(await callsOf(m)).toBe(1);
    expect(await leaseOf(m)).toEqual(leaseAfterStep);

    // The refused step did not renew the lease: it still runs out and the sweep puts the message back in the queue.
    await (
      await db()
    ).query(
      `UPDATE conversation_messages SET acked_lease_until = now() - interval '1 second' WHERE id = $1`,
      [m],
    );
    await app.get(AgentLeaseSweepJob).run();
    const [row] = await (
      await db()
    ).query(
      `SELECT pending, acked_by_hub_id, acked_lease_until, requeued_at FROM conversation_messages WHERE id = $1`,
      [m],
    );
    expect(row).toMatchObject({
      pending: true,
      acked_by_hub_id: null,
      acked_lease_until: null,
    });
    expect(row.requeued_at).not.toBeNull();
  });

  it('an organization without an agent-covering acceptance is 422 cloud-terms-agent-not-accepted', async () => {
    const conv = await create(pc);
    const m = await turn(pc, pcToken, conv);
    const admin = await db();
    // Only the v1 term (does not cover the agent) accepted: moved by the owner login, restored at the end.
    await admin.query(
      `UPDATE cloud_term_acceptances
          SET term_version = 1, term_hash = (SELECT hash FROM cloud_terms WHERE version = 1)
        WHERE organization_id = $1 AND term_version = 2`,
      [orgId],
    );
    try {
      expectProblem(
        await step(pcToken, conv.id, stepBody(m)),
        422,
        'cloud-terms-agent-not-accepted',
      );
    } finally {
      await admin.query(
        `UPDATE cloud_term_acceptances
            SET term_version = 2, term_hash = (SELECT hash FROM cloud_terms WHERE version = 2)
          WHERE organization_id = $1 AND term_version = 1`,
        [orgId],
      );
    }
    expect(composer.calls).toEqual([]);
    expect(await callsOf(m)).toBeNull();
    await expectStatus(step(pcToken, conv.id, stepBody(m)), 200);
  });

  it('a message not acked by this hub, or already answered, is 409 brain-step-not-owned', async () => {
    const conv = await create(pc);
    const pending = await k.send(ana, spaceId, conv.id, conv.keys);
    await expectStatus(Promise.resolve(pending.res), 201);
    expectProblem(
      await step(pcToken, conv.id, stepBody(pending.id)),
      409,
      'brain-step-not-owned',
    );

    const m = await turn(pc, pcToken, conv);
    const answer = await k.hubSend(pcToken, spaceId, conv.id, conv.keys, {
      answeringMessageId: m,
    });
    await expectStatus(Promise.resolve(answer.res), 201);
    expectProblem(
      await step(pcToken, conv.id, stepBody(m)),
      409,
      'brain-step-not-owned',
    );
    expect(composer.calls).toEqual([]);
    expect(await callsOf(pending.id)).toBeNull();
    expect(await callsOf(m)).toBeNull();
  });

  it('the 17th call for the same message is 422 brain-step-limit; repeating a stepIndex counts again', async () => {
    const conv = await create(pc);
    const m = await turn(pc, pcToken, conv);
    for (let i = 0; i < BRAIN_MAX_CALLS; i++) {
      // Always step 0: the back counts calls, never the agent's stepIndex.
      await expectStatus(step(pcToken, conv.id, stepBody(m)), 200);
    }
    expect(await callsOf(m)).toBe(BRAIN_MAX_CALLS);
    composer.calls.length = 0;
    expectProblem(
      await step(pcToken, conv.id, stepBody(m, { stepIndex: 1 })),
      422,
      'brain-step-limit',
    );
    expect(composer.calls).toEqual([]);
    expect(await callsOf(m)).toBe(BRAIN_MAX_CALLS);
  });

  it('a body over 256 KiB is 413; a tool result over 32 KiB is 422 validation-failed', async () => {
    expect(BRAIN_STEP_BODY_MAX_BYTES).toBe(BRAIN_BODY_MAX_BYTES);
    const conv = await create(pc);
    const m = await turn(pc, pcToken, conv);
    const toolTurns = (content: string): BrainStepRequest['turns'] => [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'folder:read', input: {} },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 't1', content }],
      },
    ];
    // Over the default 100 kB and under 256 KiB: accepted on this route (history of 150 kB, results of 32 KiB).
    const big = stepBody(m, {
      history: [
        {
          id: m,
          author: 'person',
          authorUserId: ana.userId,
          text: 'a'.repeat(150_000),
        },
      ],
      turns: toolTurns('é'.repeat(BRAIN_TOOL_RESULT_MAX_BYTES / 2)),
    });
    await expectStatus(step(pcToken, conv.id, big), 200);
    expect(await callsOf(m)).toBe(1);

    const tooBig = stepBody(m, {
      history: [{ id: m, author: 'person', text: 'a'.repeat(270_000) }],
    });
    const res413 = await step(pcToken, conv.id, tooBig);
    expect(res413.status).toBe(413);

    // 32 KiB + 1 byte in UTF-8 (the 'é' is 2 bytes): one result too large.
    const oversized = stepBody(m, {
      turns: toolTurns('é'.repeat(BRAIN_TOOL_RESULT_MAX_BYTES / 2) + 'a'),
    });
    expectProblem(
      await step(pcToken, conv.id, oversized),
      422,
      'validation-failed',
    );
    // A malformed request never uses a call slot (size check before the counter).
    expect(await callsOf(m)).toBe(1);
    // A malformed content block is refused by the format check too.
    expectProblem(
      await step(
        pcToken,
        conv.id,
        stepBody(m, {
          turns: [
            {
              role: 'user',
              content: [{ type: 'image', url: 'x' }],
            },
          ] as unknown as BrainStepRequest['turns'],
        }),
      ),
      422,
      'validation-failed',
    );
    expect(await callsOf(m)).toBe(1);
    expect(composer.calls).toHaveLength(1);
  });
});
