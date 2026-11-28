import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { llmToolName } from '../../src/cloud/application/brain/agent-tool-offer.js';
import { Embedder } from '../../src/cloud/application/ports/embedder.js';
import { LanguageModel } from '../../src/cloud/application/ports/language-model.js';
import { AnswerConversationJob } from '../../src/cloud/application/responder/answer-conversation.job.js';
import { ResponderClock } from '../../src/cloud/application/responder/responder-clock.js';
import type { BrainStepRequest } from '../../src/cloud/domain/brain-step.js';
import { answerIdFor } from '../../src/cloud/domain/responder.js';
import { FakeEmbedder } from '../../src/cloud/testing/fake-embedder.js';
import { FakeLanguageModel } from '../../src/cloud/testing/fake-language-model.js';
import { AgentLeaseSweepJob } from '../../src/conversations/application/agent-lease-sweep.job.js';
import { AGENT_ACK_LEASE_MS } from '../../src/conversations/domain/conversation-limits.js';
import { newId } from '../../src/shared/domain/id.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import {
  openConversationKey,
  openMessage,
} from '../support/conversation-crypto.js';
import {
  conversationsKit,
  hubRecipientOf,
  type ConversationKeys,
} from '../support/conversations-kit.js';
import { hubClient } from '../support/hub-client.js';
import type { ClaimedHub } from '../support/hubs-kit.js';
import {
  expectStatus,
  identityClient,
  recipientOf,
  type KeyedUser,
} from '../support/identity-client.js';
import { agentsKit } from '../support/agents-kit.js';
import { cloudSwitch } from '../support/space-manifest.js';

/** The responder's clock (the database's), moved by the spec instead of sleeping 30 s. */
class TestClock {
  offsetMs = 0;
  async now(): Promise<Date> {
    const [row] = (await (
      await adminDataSource()
    ).query(`SELECT clock_timestamp() AS now`)) as { now: Date }[];
    return new Date(row!.now.getTime() + this.offsetMs);
  }
}

type FeedItem = {
  type: string;
  deleted: boolean;
  data: Record<string, unknown>;
};

// O agente do PC de ponta a ponta (spec pc-agent; Task 13 do plano), só pelas rotas HTTP reais, com a cifra real e o
// papel de runtime (RLS valendo): apresentação v2 (`kind: 'pc'`), reivindicação, vínculo com a organização, espaço na
// nuvem ativa, termo v2, política, catálogo, ack com prazo, passos do cérebro (modelo e embedder falsos por DI), resposta
// cifrada com `answeringMessageId`, auditoria, e o agente desligado no meio: o prazo vence (movido no banco, relógio do
// banco), a varredura devolve à fila e a nuvem de reserva responde. Os e2e rodam sem workers: a varredura e a tarefa da
// nuvem são chamadas direto.
describe('pc agent end to end (e2e)', () => {
  let app: INestApplication;
  const llm = new FakeLanguageModel();
  const embedder = new FakeEmbedder();
  const clock = new TestClock();
  const c = identityClient(() => app);
  const s = c.spaces;
  const h = hubClient(() => app);
  const k = conversationsKit(() => app);
  const cloud = cloudSwitch(() => app);
  const agents = agentsKit(() => app);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const db = async () => adminDataSource();

  const ERP = 'mcp:erp/consultar';
  const QUESTION = 'Qual o saldo do pedido 42 no ERP?';
  const TOOL_RESULT = 'saldo: 10 unidades';
  const FINAL = 'O pedido 42 tem 10 unidades.';
  const SECOND = 'E o prazo de entrega do pedido 42?';

  let olivia: KeyedUser; // admin da organização, Gestora do espaço
  let bruno: KeyedUser; // membro, editor do espaço, dono do PC
  let orgId: string;
  let spaceId: string;
  let pc: ClaimedHub;
  let pcToken: string;

  /** The conversation feed of a person or of the hub, decrypted messages only. */
  const feed = async (path: string, token: string, conversationId: string) =>
    (
      (
        await expectStatus(
          http()
            .get(path)
            .query({ since: 0, conversationId })
            .set(bearer(token)),
          200,
        )
      ).body.items as FeedItem[]
    ).filter((i) => !i.deleted);
  const open = async (
    keys: ConversationKeys,
    conversationId: string,
    m: Record<string, unknown>,
  ) => {
    const keyVersion = m.keyVersion as number;
    return new TextDecoder().decode(
      await openMessage(
        keys[keyVersion - 1]!,
        { spaceId, conversationId, recordId: m.id as string, keyVersion },
        Buffer.from(m.encryptedBody as string, 'base64url'),
      ),
    );
  };
  const step = (conversationId: string, body: BrainStepRequest) =>
    http()
      .post(`/hub/conversations/${conversationId}/brain/step`)
      .set(bearer(pcToken))
      .send(body);
  const messageRow = async (id: string) =>
    (
      await (
        await db()
      ).query(
        `SELECT pending, acked_by_hub_id, acked_by_cloud, acked_lease_until, requeued_at,
                requeued_lease_expired
           FROM conversation_messages WHERE id = $1`,
        [id],
      )
    )[0] as {
      pending: boolean;
      acked_by_hub_id: string | null;
      acked_by_cloud: boolean;
      acked_lease_until: Date | null;
      requeued_at: Date | null;
      requeued_lease_expired: boolean;
    };

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp({
      overrides: [
        { provide: LanguageModel, useValue: llm },
        { provide: Embedder, useValue: embedder },
        { provide: ResponderClock, useValue: clock },
      ],
    });
    olivia = await s.signUpKeyed('olivia@example.com', 'Olivia');
    bruno = await s.signUpKeyed('bruno@example.com', 'Bruno');
    const o = await s.orgWithKit(olivia, 'Distribuidora');
    orgId = o.orgId;
    await s.joinOrg(olivia, orgId, bruno);
    const sp = await s.create(olivia, orgId, o.kit.publicKey, 'Pedidos');
    await expectStatus(Promise.resolve(sp.res), 201);
    spaceId = sp.spaceId;
    await expectStatus(
      s.addMember(
        olivia.token,
        spaceId,
        recipientOf(bruno),
        [sp.key],
        'space_editor',
      ),
      201,
    );
    // The organization accepts the term v2 (covers the agent); switchOn repeats the same acceptance and activates.
    const terms = await expectStatus(
      http()
        .get(`/organizations/${orgId}/cloud/terms`)
        .set(bearer(olivia.token)),
      200,
    );
    expect(terms.body.current.version).toBe(2);
    const [v2] = await (
      await db()
    ).query(`SELECT covers_agent FROM cloud_terms WHERE version = 2`);
    expect(v2.covers_agent).toBe(true);
    await expectStatus(
      http()
        .post(`/organizations/${orgId}/cloud/terms/accept`)
        .set(bearer(olivia.token))
        .send({
          version: terms.body.current.version,
          hash: terms.body.current.hash,
        }),
      200,
    );
    await cloud.switchOn(olivia, orgId, spaceId, [sp.key]);
  }, 240_000);

  afterAll(async () => {
    await app?.close();
  });

  it('enrolls, answers with a pc tool, is audited, and when switched off the cloud reserve answers', async () => {
    // 1. The pc agent enrolls (v2, kind pc) and Bruno's app claims it by code.
    pc = await h.onboard(bruno.token, 'PC do Bruno', { kind: 'pc' });
    pcToken = await h.authenticate(pc);
    const [hubRow] = await (
      await db()
    ).query(`SELECT kind, owner_user_id FROM hubs WHERE id = $1`, [pc.hubId]);
    expect(hubRow).toEqual({ kind: 'pc', owner_user_id: bruno.userId });

    // 2. Bruno links it to the organization (the admin approves when the policy asks) and gives it the space.
    const link = await expectStatus(
      http()
        .post(`/hubs/${pc.hubId}/organizations`)
        .set(bearer(bruno.token))
        .send({ organizationId: orgId }),
      201,
    );
    if (link.body.status !== 'approved') {
      await expectStatus(
        http()
          .post(`/hubs/${pc.hubId}/organizations/${orgId}/approve`)
          .set(bearer(olivia.token))
          .send({}),
        200,
      );
    }
    await expectStatus(
      http()
        .post(`/hubs/${pc.hubId}/spaces`)
        .set(bearer(bruno.token))
        .send({ spaceId }),
      201,
    );

    // 3. The agent publishes its catalog; the admin publishes the policy (mcp:erp/* allow, the delete denied).
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
    const rules = [
      {
        subject: { kind: 'all' },
        resource: { kind: 'tool', pattern: 'mcp:erp/*' },
        effect: 'allow',
      },
      {
        subject: { kind: 'all' },
        resource: { kind: 'tool', pattern: 'mcp:erp/apagar' },
        effect: 'deny',
      },
    ];
    const published = await expectStatus(
      http()
        .put(`/organizations/${orgId}/agent-policy`)
        .set(bearer(olivia.token))
        .send({ baseVersion: 0, rules }),
      200,
    );
    const policyVersion = published.body.version as number;
    expect(policyVersion).toBe(1);
    // The agent learns of it from the sync (id and version only) and downloads it.
    const synced = (await h.syncAll(pcToken)).items.filter(
      (i) => i.type === 'agent_policy',
    );
    expect(synced.map((i) => i.data)).toContainEqual({
      organizationId: orgId,
      version: policyVersion,
    });
    const downloaded = await expectStatus(
      http().get('/hub/agent/policy').set(bearer(pcToken)),
      200,
    );
    expect(
      (downloaded.body.items as { organizationId: string }[]).find(
        (i) => i.organizationId === orgId,
      ),
    ).toEqual({ organizationId: orgId, version: policyVersion, rules });

    // 4. Bruno opens a conversation executed by his pc, with the cloud reserve, and asks.
    const serverPk = await s.serverPublicKey(bruno.token);
    const conv = await k.create(bruno, spaceId, {
      serverPublicKey: serverPk,
      executor: hubRecipientOf(pc),
    });
    await expectStatus(Promise.resolve(conv.res), 201);
    const keys = conv.keys as ConversationKeys;
    const asked = await k.send(bruno, spaceId, conv.id, keys, {
      text: QUESTION,
    });
    await expectStatus(Promise.resolve(asked.res), 201);

    // 5. The agent reads it from its feed with its own copy of the key, and acks it (15 min lease).
    const hubItems = await feed('/hub/conversations/changes', pcToken, conv.id);
    const grant = hubItems.find(
      (i) => i.type === 'conversation_key_grant' && i.data.hubId === pc.hubId,
    )!;
    const hubKey = await openConversationKey(
      grant.data.wrappedKey as string,
      pc.identity.encryptionPublicKey,
      pc.identity.encryptionPrivateKey,
    );
    const question = hubItems.find(
      (i) => i.type === 'conversation_message' && i.data.id === asked.id,
    )!;
    expect(question.data.pending).toBe(true);
    expect(await open([hubKey], conv.id, question.data)).toBe(QUESTION);
    await expectStatus(k.hubAck(pcToken, conv.id, asked.id), 200);
    const acked = await messageRow(asked.id);
    expect(acked.acked_by_hub_id).toBe(pc.hubId);
    expect(acked.acked_lease_until).not.toBeNull();

    // 6. Step 0: the back offers the allowed tool (never the denied one) and the model asks for it -> tools.
    const history = [
      {
        id: asked.id,
        author: 'person' as const,
        authorUserId: bruno.userId,
        text: QUESTION,
      },
    ];
    llm.enqueue({
      text: 'Vou consultar o ERP.',
      toolCalls: [
        { id: 'c1', name: llmToolName(ERP), input: { pedido: '42' } },
      ],
    });
    const first = await expectStatus(
      step(conv.id, { messageId: asked.id, stepIndex: 0, history, turns: [] }),
      200,
    );
    expect(first.body).toEqual({
      kind: 'tools',
      text: 'Vou consultar o ERP.',
      toolCalls: [
        { id: 'c1', name: ERP, input: { pedido: '42' }, effect: 'allow' },
      ],
      policyVersion,
    });
    const offered = (llm.calls[0]!.tools ?? []).map((t) => t.name);
    expect(offered).toContain(llmToolName(ERP));
    expect(offered).not.toContain(llmToolName('mcp:erp/apagar'));

    // 7. The agent runs the tool on the PC, and step 1 carries the result -> final.
    const startedAt = new Date().toISOString();
    llm.enqueue({ text: FINAL });
    const second = await expectStatus(
      step(conv.id, {
        messageId: asked.id,
        stepIndex: 1,
        history,
        turns: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Vou consultar o ERP.' },
              {
                type: 'tool_use',
                id: 'c1',
                name: ERP,
                input: { pedido: '42' },
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
      200,
    );
    expect(second.body).toEqual({ kind: 'final', text: FINAL, policyVersion });
    expect(JSON.stringify(llm.calls[1]!.messages)).toContain(TOOL_RESULT);

    // 8. The encrypted answer names the message it answers; the action goes to the audit.
    const answer = await k.hubSend(pcToken, spaceId, conv.id, keys, {
      text: FINAL,
      answeringMessageId: asked.id,
    });
    await expectStatus(Promise.resolve(answer.res), 201);
    const actionId = newId();
    await expectStatus(
      http()
        .post('/hub/agent/actions')
        .set(bearer(pcToken))
        .send({
          items: [
            {
              id: actionId,
              conversationId: conv.id,
              messageId: asked.id,
              toolName: ERP,
              effect: 'allow',
              decision: 'executed',
              startedAt,
              durationMs: 80,
              policyVersion,
            },
          ],
        }),
      200,
    );

    // Bruno reads the agent's answer in his feed (the plaintext never touched the back).
    const brunoItems = await feed(
      '/conversations/changes',
      bruno.token,
      conv.id,
    );
    const fromAgent = brunoItems.find(
      (i) => i.type === 'conversation_message' && i.data.id === answer.id,
    )!;
    expect(fromAgent.data.authorHubId).toBe(pc.hubId);
    expect(await open(keys, conv.id, fromAgent.data)).toBe(FINAL);

    // 9. The admin sees the action (ids, tool name, decision; no arguments nor result).
    const audit = await expectStatus(
      http()
        .get(`/organizations/${orgId}/agent-actions`)
        .set(bearer(olivia.token)),
      200,
    );
    expect(audit.body.items).toEqual([
      expect.objectContaining({
        id: actionId,
        hubId: pc.hubId,
        userId: bruno.userId,
        spaceId,
        conversationId: conv.id,
        messageId: asked.id,
        toolName: ERP,
        effect: 'allow',
        decision: 'executed',
        policyVersion,
      }),
    ]);
    expect(JSON.stringify(audit.body)).not.toContain(TOOL_RESULT);

    // 10. Second message: the agent acks it and goes off (PC switched off mid-turn). The lease runs out (database
    // clock: moved into the past), the sweep puts it back in the queue and the cloud reserve answers.
    const again = await k.send(bruno, spaceId, conv.id, keys, { text: SECOND });
    await expectStatus(Promise.resolve(again.res), 201);
    await expectStatus(k.hubAck(pcToken, conv.id, again.id), 200);
    const lease = (await messageRow(again.id)).acked_lease_until!;
    const [{ now }] = await (
      await db()
    ).query(`SELECT clock_timestamp() AS now`);
    expect(
      Math.abs(
        lease.getTime() - ((now as Date).getTime() + AGENT_ACK_LEASE_MS),
      ),
    ).toBeLessThan(10_000);
    await (
      await db()
    ).query(
      `UPDATE conversation_messages SET acked_lease_until = now() - interval '1 second' WHERE id = $1`,
      [again.id],
    );
    const swept = await app.get(AgentLeaseSweepJob).run();
    expect(swept).toMatchObject({ requeued: 1 });
    const requeued = await messageRow(again.id);
    expect(requeued).toMatchObject({
      pending: true,
      acked_by_hub_id: null,
      acked_lease_until: null,
    });
    expect(requeued.requeued_at).not.toBeNull();
    // The sweep signalled the cloud: its job for the conversation is due now (the agent already had its 15 min).
    const [job] = await (
      await db()
    ).query(
      `SELECT start_after <= now() AS due FROM pgboss.job
        WHERE name = 'cloud.answer-conversation' AND data->>'conversationId' = $1 AND state = 'created'`,
      [conv.id],
    );
    expect(job).toEqual({ due: true });

    const runCloud = () =>
      app
        .get(AnswerConversationJob)
        .run({ organizationId: orgId, spaceId, conversationId: conv.id });
    // Decision B8: the message is marked `requeued_lease_expired`, and the planner answers it at once (no new 30 s
    // Hub window): the first look acks and answers, with the clock not moved.
    expect(requeued.requeued_lease_expired).toBe(true);
    await runCloud();
    expect(await messageRow(again.id)).toMatchObject({
      pending: false,
      acked_by_cloud: true,
    });
    const items = await feed('/conversations/changes', bruno.token, conv.id);
    const fromCloud = items.find(
      (i) => i.type === 'conversation_message' && i.data.authorCloud === true,
    )!;
    expect(fromCloud.data.id).toBe(answerIdFor(again.id));
    expect(JSON.parse(await open(keys, conv.id, fromCloud.data))).toMatchObject(
      {
        text: `fake answer: ${SECOND}`,
      },
    );

    // The agent comes back too late: its answer is 409 and never a second one.
    const late = await k.hubSend(pcToken, spaceId, conv.id, keys, {
      text: 'tarde demais',
      answeringMessageId: again.id,
    });
    expect(late.res.status).toBe(409);
    expect(String(late.res.body.type)).toMatch(/\/brain-step-not-owned$/);
  });
});
