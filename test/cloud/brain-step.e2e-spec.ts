import { Logger, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Response } from 'supertest';
import { llmToolName } from '../../src/cloud/application/brain/agent-tool-offer.js';
import { BrainComposer } from '../../src/cloud/application/brain/brain-step.use-case.js';
import { Embedder } from '../../src/cloud/application/ports/embedder.js';
import {
  LanguageModel,
  LanguageModelError,
} from '../../src/cloud/application/ports/language-model.js';
import {
  embedText,
  FAKE_EMBEDDING_MODEL,
  FakeEmbedder,
} from '../../src/cloud/testing/fake-embedder.js';
import { FakeLanguageModel } from '../../src/cloud/testing/fake-language-model.js';
import { newId } from '../../src/shared/domain/id.js';
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
import { agentsKit } from '../support/agents-kit.js';
import {
  cloudSwitch,
  setAiBudgetInDb,
  TEST_AI_BUDGET_MICRO_USD,
} from '../support/space-manifest.js';

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
          hubId: pc.hubId,
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

// O compositor de verdade (Task 11): oferta filtrada pela ACL, busca no espaço só na primeira chamada da mensagem,
// prompt, laço do modelo dentro do passo e orçamento. Modelo e embedder falsos por DI; o resto real (HTTP, RLS, livro do
// orçamento, contador). Review Focus 1 (autor gravado), 2 (ferramenta não oferecida) e 3 (ACL muda entre passos).
describe('cloud: the brain composer (e2e)', () => {
  let app: INestApplication;
  const llm = new FakeLanguageModel();
  const embedder = new FakeEmbedder();
  const c = identityClient(() => app);
  const s = c.spaces;
  const h = hubClient(() => app);
  const hubs = hubsKit(() => app);
  const k = conversationsKit(() => app);
  const cloud = cloudSwitch(() => app);
  const agents = agentsKit(() => app);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  const QUESTION = 'Qual o saldo do pedido ZANZIBAR-42 no ERP?';
  const CHUNK_TEXT =
    'O saldo do pedido ZANZIBAR-42 fica no ERP, TRECHO-LEGIVEL-77.';
  const TOOL_RESULT = 'RESULTADO-DA-FERRAMENTA-SECRETO-991';
  const ERP = 'mcp:erp/consultar';

  let olivia: KeyedUser; // admin, Gestora, dona do PC
  let ana: KeyedUser; // editora
  let orgId: string;
  let spaceId: string;
  let pc: ClaimedHub;
  let pcToken: string;
  let serverPk: string;
  let policyVersion = 0;

  const db = async () => adminDataSource();
  const setPolicy = async (rules: unknown[]) => {
    const res = await expectStatus(
      http()
        .put(`/organizations/${orgId}/agent-policy`)
        .set(bearer(olivia.token))
        .send({ baseVersion: policyVersion, rules }),
      200,
    );
    policyVersion = res.body.version as number;
  };
  const allow = (pattern: string, effect = 'allow') => ({
    subject: { kind: 'all' },
    resource: { kind: 'tool', pattern },
    effect,
  });
  /** `asker` asks in a conversation executed by the PC, and the PC acks. */
  const turn = async (asker: KeyedUser) => {
    const conv = await k.create(olivia, spaceId, {
      serverPublicKey: serverPk,
      executor: hubRecipientOf(pc),
    });
    await expectStatus(Promise.resolve(conv.res), 201);
    await expectStatus(
      k.share(olivia, spaceId, conv.id, [recipientOf(ana)], conv.keys),
      200,
    );
    const sent = await k.send(
      asker,
      spaceId,
      conv.id,
      conv.keys as ConversationKeys,
      {
        text: QUESTION,
      },
    );
    await expectStatus(Promise.resolve(sent.res), 201);
    await expectStatus(k.hubAck(pcToken, conv.id, sent.id), 200);
    return { conversationId: conv.id, messageId: sent.id };
  };
  const body = (
    asker: KeyedUser,
    messageId: string,
    extra: Partial<BrainStepRequest> = {},
  ): BrainStepRequest => ({
    messageId,
    stepIndex: 0,
    history: [
      {
        id: messageId,
        author: 'person',
        authorUserId: asker.userId,
        text: QUESTION,
      },
    ],
    turns: [],
    ...extra,
  });
  const step = (conversationId: string, b: BrainStepRequest) =>
    http()
      .post(`/hub/conversations/${conversationId}/brain/step`)
      .set(bearer(pcToken))
      .send(b);
  const brainRow = async (messageId: string) =>
    (
      await (
        await db()
      ).query(
        `SELECT calls, cost_micro_usd::text AS cost, chunk_ids FROM agent_brain_steps WHERE message_id = $1`,
        [messageId],
      )
    )[0] as { calls: number; cost: string; chunk_ids: string[] | null };
  const agentUsage = async () =>
    (await (
      await db()
    ).query(
      `SELECT kind, cost_micro_usd::text AS cost, calls FROM cloud_ai_usage WHERE organization_id = $1 AND kind = 'agent'`,
      [orgId],
    )) as { kind: string; cost: string; calls: number }[];
  /** One indexed chunk of the space, embedded by the fake embedder (what the indexing would write). */
  const seedChunk = async (text: string) => {
    const admin = await db();
    const fileId = newId();
    const objectId = newId();
    const versionId = newId();
    const [file] = await admin.query(
      `INSERT INTO cloud_files (organization_id, space_id, file_id, manifest, name, media_type, source_kind,
                                part_object_ids, part_version_ids, status, embedding_model, chunk_count, indexed_at)
       VALUES ($1, $2, $3, 'hub', 'pedidos.md', 'text/markdown', 'file', ARRAY[$4::uuid], ARRAY[$5::uuid],
               'indexed', $6, 1, now())
       RETURNING id`,
      [orgId, spaceId, fileId, objectId, versionId, FAKE_EMBEDDING_MODEL],
    );
    const [row] = await admin.query(
      `INSERT INTO cloud_chunks (organization_id, space_id, cloud_file_id, file_id, object_id, version_id, position,
                                 text, embedding, embedding_model)
       VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8::vector, $9)
       RETURNING id`,
      [
        orgId,
        spaceId,
        file.id,
        fileId,
        objectId,
        versionId,
        text,
        `[${embedText(text).join(',')}]`,
        FAKE_EMBEDDING_MODEL,
      ],
    );
    return row.id as string;
  };

  let chunkId: string;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp({
      overrides: [
        { provide: LanguageModel, useValue: llm },
        { provide: Embedder, useValue: embedder },
      ],
    });
    olivia = await s.signUpKeyed('olivia@example.com', 'Olivia');
    ana = await s.signUpKeyed('ana@example.com', 'Ana');
    const o = await s.orgWithKit(olivia, 'Agente');
    orgId = o.orgId;
    await s.joinOrg(olivia, orgId, ana);
    pc = await h.onboard(olivia.token, 'PC da Olivia', { kind: 'pc' });
    await hubs.link(olivia, pc.hubId, orgId);
    const sp = await s.create(olivia, orgId, o.kit.publicKey, 'Projetos');
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
    serverPk = await s.serverPublicKey(olivia.token);
    await cloud.switchOn(olivia, orgId, spaceId, [sp.key]);
    pcToken = await h.authenticate(pc);
    await expectStatus(
      agents.publishTools(pc, [
        {
          name: ERP,
          title: 'Consultar pedido',
          description: 'Consulta um pedido no ERP.',
          inputSchema: {
            type: 'object',
            properties: { pedido: { type: 'string' } },
          },
          category: 'mcp',
        },
        {
          name: 'mcp:erp/apagar',
          title: 'Apagar pedido',
          description: 'Apaga um pedido no ERP.',
          inputSchema: {
            type: 'object',
            properties: { pedido: { type: 'string' } },
          },
          category: 'mcp',
        },
      ]),
      204,
    );
    await setPolicy([allow('mcp:erp/*'), allow('mcp:erp/apagar', 'deny')]);
    chunkId = await seedChunk(CHUNK_TEXT);
  }, 240_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    llm.reset();
    embedder.calls.length = 0;
  });

  it('step 0 retrieves chunks of the space and returns tools with effect', async () => {
    const t = await turn(olivia);
    llm.enqueue({
      text: 'Vou consultar o ERP.',
      toolCalls: [
        { id: 'c1', name: llmToolName(ERP), input: { pedido: 'ZANZIBAR-42' } },
      ],
    });
    const res = await expectStatus(
      step(t.conversationId, body(olivia, t.messageId)),
      200,
    );
    expect(res.body).toEqual({
      kind: 'tools',
      text: 'Vou consultar o ERP.',
      toolCalls: [
        {
          id: 'c1',
          name: ERP,
          input: { pedido: 'ZANZIBAR-42' },
          effect: 'allow',
        },
      ],
      policyVersion,
    });
    // Retrieval: the question embedded once, the space's chunk in the prompt, only its id stored.
    expect(embedder.calls).toEqual([{ count: 1, kind: 'query' }]);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.system).toContain(CHUNK_TEXT);
    expect(llm.calls[0]!.system).toContain('AGINDO NO PC');
    // Only what the policy allows is offered (the denied tool never reaches the model).
    expect(llm.calls[0]!.tools!.map((x) => x.name)).toEqual([llmToolName(ERP)]);
    expect(await brainRow(t.messageId)).toMatchObject({
      calls: 1,
      chunk_ids: [chunkId],
    });

    // Step 1 (with the tool result): the chunks re-read by id, no new embedding.
    llm.enqueue({ text: 'O saldo é 10.' });
    const res1 = await expectStatus(
      step(
        t.conversationId,
        body(olivia, t.messageId, {
          stepIndex: 1,
          turns: [
            {
              role: 'assistant',
              content: [
                { type: 'text', text: 'Vou consultar o ERP.' },
                {
                  type: 'tool_use',
                  id: 'c1',
                  name: ERP,
                  input: { pedido: 'ZANZIBAR-42' },
                },
              ],
            },
            {
              role: 'user',
              content: [
                { type: 'tool_result', toolUseId: 'c1', content: TOOL_RESULT },
              ],
            },
          ],
        }),
      ),
      200,
    );
    expect(res1.body).toEqual({
      kind: 'final',
      text: 'O saldo é 10.',
      policyVersion,
    });
    expect(embedder.calls).toEqual([{ count: 1, kind: 'query' }]);
    expect(llm.calls[1]!.system).toContain(CHUNK_TEXT);
    // The previous turns reach the model with the model-safe tool name.
    expect(JSON.stringify(llm.calls[1]!.messages)).toContain(TOOL_RESULT);
    expect(JSON.stringify(llm.calls[1]!.messages)).toContain(llmToolName(ERP));
    expect((await brainRow(t.messageId)).calls).toBe(2);
  });

  it("a question by someone who is not the agent's owner gets no pc tool, whatever the history says", async () => {
    const t = await turn(ana);
    llm.enqueue({ text: 'Respondo só com o que sei.' });
    // The agent lies: the history claims the owner asked.
    const res = await expectStatus(
      step(t.conversationId, body(olivia, t.messageId)),
      200,
    );
    expect(res.body).toEqual({
      kind: 'final',
      text: 'Respondo só com o que sei.',
      policyVersion,
    });
    expect(llm.calls[0]!.tools ?? []).toEqual([]);
  });

  it('a call to a non-offered tool becomes an error tool_result and the model is called again inside the same step', async () => {
    const t = await turn(olivia);
    llm.enqueue(
      {
        toolCalls: [
          {
            id: 'x1',
            name: llmToolName('mcp:erp/apagar'),
            input: { pedido: '1' },
          },
        ],
      },
      { text: 'Não posso apagar pedidos.' },
    );
    const res = await expectStatus(
      step(t.conversationId, body(olivia, t.messageId)),
      200,
    );
    expect(res.body).toEqual({
      kind: 'final',
      text: 'Não posso apagar pedidos.',
      policyVersion,
    });
    expect(llm.calls).toHaveLength(2);
    const fedBack = llm.calls[1]!.messages.at(-1)!;
    expect(fedBack.role).toBe('user');
    expect(fedBack.content).toEqual([
      expect.objectContaining({
        type: 'tool_result',
        toolUseId: 'x1',
        isError: true,
      }),
    ]);
    expect((await brainRow(t.messageId)).calls).toBe(2);
  });

  it('a policy change between steps changes the offer and policyVersion (Review Focus 3)', async () => {
    const t = await turn(olivia);
    llm.enqueue({
      toolCalls: [{ id: 'c1', name: llmToolName(ERP), input: { pedido: '7' } }],
    });
    const first = await expectStatus(
      step(t.conversationId, body(olivia, t.messageId)),
      200,
    );
    const before = policyVersion;
    expect(first.body).toMatchObject({ kind: 'tools', policyVersion: before });
    expect(first.body.toolCalls[0].effect).toBe('allow');

    await setPolicy([
      allow('mcp:erp/*', 'confirm'),
      allow('mcp:erp/apagar', 'deny'),
    ]);
    llm.enqueue({
      toolCalls: [{ id: 'c2', name: llmToolName(ERP), input: { pedido: '8' } }],
    });
    const second = await expectStatus(
      step(t.conversationId, body(olivia, t.messageId, { stepIndex: 1 })),
      200,
    );
    expect(second.body).toMatchObject({
      kind: 'tools',
      policyVersion: before + 1,
    });
    expect(second.body.toolCalls[0].effect).toBe('confirm');

    await setPolicy([]);
    llm.enqueue(
      { toolCalls: [{ id: 'c3', name: llmToolName(ERP), input: {} }] },
      { text: 'Sem ferramentas agora.' },
    );
    const third = await expectStatus(
      step(t.conversationId, body(olivia, t.messageId, { stepIndex: 2 })),
      200,
    );
    expect(third.body).toEqual({
      kind: 'final',
      text: 'Sem ferramentas agora.',
      policyVersion: before + 2,
    });
    expect(llm.calls[2]!.tools ?? []).toEqual([]);
    await setPolicy([allow('mcp:erp/*'), allow('mcp:erp/apagar', 'deny')]);
  });

  it("budget refused = { kind: 'refused', reason: 'ai-budget-exceeded', resetsAt }, without calling the model", async () => {
    const t = await turn(olivia);
    await setAiBudgetInDb(orgId, 0);
    try {
      const res = await expectStatus(
        step(t.conversationId, body(olivia, t.messageId)),
        200,
      );
      expect(res.body).toEqual({
        kind: 'refused',
        reason: 'ai-budget-exceeded',
        resetsAt: expect.stringMatching(/^\d{4}-\d{2}-01T00:00:00\.000Z$/),
      });
    } finally {
      await setAiBudgetInDb(orgId, TEST_AI_BUDGET_MICRO_USD);
    }
    expect(llm.calls).toHaveLength(0);
    expect(embedder.calls).toHaveLength(0);
    // The refused step keeps its slot.
    expect((await brainRow(t.messageId)).calls).toBe(1);
  });

  it('the step records cost in cloud_ai_usage with kind agent and in agent_brain_steps', async () => {
    const t = await turn(olivia);
    const before = await agentUsage();
    const spentBefore = before.reduce((sum, r) => sum + BigInt(r.cost), 0n);
    llm.enqueue({
      text: 'Pronto.',
      usage: { inputTokens: 10_000, outputTokens: 1_000 },
    });
    await expectStatus(step(t.conversationId, body(olivia, t.messageId)), 200);
    const after = await agentUsage();
    const spentAfter = after.reduce((sum, r) => sum + BigInt(r.cost), 0n);
    expect(spentAfter).toBeGreaterThan(spentBefore);
    const row = await brainRow(t.messageId);
    expect(BigInt(row.cost)).toBe(spentAfter - spentBefore);
    expect(BigInt(row.cost)).toBeGreaterThan(0n);
  });

  it('nothing readable is logged', async () => {
    const levels = [
      'log',
      'warn',
      'error',
      'debug',
      'verbose',
      'fatal',
    ] as const;
    const spies = levels.flatMap((level) => [
      vi.spyOn(Logger.prototype, level),
      vi.spyOn(Logger, level),
    ]);
    try {
      const t = await turn(olivia);
      const turns: BrainStepRequest['turns'] = [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'c1',
              name: ERP,
              input: { pedido: 'ZANZIBAR-42' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 'c1', content: TOOL_RESULT },
          ],
        },
      ];
      // A normal step with a dropped call, and a failing one (the error path is logged by the filter).
      llm.enqueue(
        {
          toolCalls: [
            { id: 'x1', name: 'shell_exec', input: { cmd: TOOL_RESULT } },
          ],
        },
        { text: `Resposta com ${TOOL_RESULT}` },
        { error: new LanguageModelError(true, 'throttled') },
      );
      await expectStatus(
        step(t.conversationId, body(olivia, t.messageId, { turns })),
        200,
      );
      const failed = await step(
        t.conversationId,
        body(olivia, t.messageId, { stepIndex: 1, turns }),
      );
      expect(failed.status).toBe(500);
      expect(JSON.stringify(failed.body)).not.toContain(TOOL_RESULT);
      expect(spies.some((spy) => spy.mock.calls.length > 0)).toBe(true);
      const logged = spies
        .flatMap((spy) => spy.mock.calls)
        .map((args) =>
          JSON.stringify(args, (_k, v: unknown) =>
            v instanceof Error
              ? { name: v.name, message: v.message, stack: v.stack }
              : v,
          ),
        )
        .join('\n');
      for (const secret of [
        QUESTION,
        'ZANZIBAR-42',
        TOOL_RESULT,
        CHUNK_TEXT,
        'TRECHO-LEGIVEL-77',
      ]) {
        expect(logged).not.toContain(secret);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
