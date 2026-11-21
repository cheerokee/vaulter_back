import { Logger } from '@nestjs/common';
import type { AgentPolicyReader } from '../../../agents/application/agent-policy-reader.js';
import type { AgentToolCatalog } from '../../../agents/application/agent-tool-catalog.js';
import type { AgentToolDef } from '../../../agents/domain/agent-tool.js';
import type { AgentTurnView } from '../../../conversations/application/agent-turn.js';
import { newId } from '../../../shared/domain/id.js';
import type { UnitOfWork } from '../../../shared/infra/db/unit-of-work.js';
import type { SpaceCloud } from '../../../spaces/application/space-cloud.js';
import { AiPricing } from '../../domain/ai-pricing.js';
import type { BrainStepRequest } from '../../domain/brain-step.js';
import type { ChunkHit } from '../../domain/indexing.repositories.js';
import { FakeEmbedder } from '../../testing/fake-embedder.js';
import { FakeLanguageModel } from '../../testing/fake-language-model.js';
import type { AiBudget } from '../ai-budget.js';
import type { ResponderClock } from '../responder/responder-clock.js';
import { llmToolName } from './agent-tool-offer.js';
import { BrainComposerImpl } from './brain-composer.js';
import type { BrainStepCounter } from './brain-step-counter.js';

const OWNER = newId();
const OTHER = newId();
const ORG = newId();
const NOW = new Date('2026-11-21T12:00:00.000Z');
const QUESTION = 'Qual o saldo do pedido 42 no ERP?';

const erp: AgentToolDef = {
  name: 'mcp:erp/consultar',
  title: 'Consultar',
  description: 'Consulta o ERP.',
  inputSchema: { type: 'object', properties: { pedido: { type: 'number' } } },
  category: 'mcp',
};

const chunk = (text: string): ChunkHit => ({
  id: newId(),
  fileId: newId(),
  name: 'contrato.md',
  path: null,
  position: 0,
  text,
  distance: 0.1,
});

function setup(
  opts: { author?: string; storedChunkIds?: string[] | null } = {},
) {
  const view: AgentTurnView = {
    organizationId: ORG,
    spaceId: newId(),
    conversationId: newId(),
    messageId: newId(),
    hubId: newId(),
    authorUserId: opts.author ?? OWNER,
    hubOwnerUserId: OWNER,
    cloudReserve: true,
  };
  const catalog = { toolsOf: vi.fn().mockResolvedValue([erp]) };
  const policies = {
    current: vi.fn().mockResolvedValue({
      version: 7,
      rules: [
        {
          subject: { kind: 'all' },
          resource: { kind: 'tool', pattern: 'mcp:erp/*' },
          effect: 'allow',
        },
      ],
    }),
  };
  const counter = {
    consume: vi.fn().mockResolvedValue('ok'),
    addCost: vi.fn(),
    chunkIdsOf: vi.fn().mockResolvedValue(opts.storedChunkIds ?? null),
    recordChunkIds: vi.fn(),
  };
  const reservation = { id: newId(), organizationId: ORG };
  const budget = {
    tryReserve: vi.fn().mockResolvedValue({ reservation }),
    settle: vi.fn(),
    release: vi.fn(),
  };
  const found = [chunk('O prazo do contrato é de 12 meses.')];
  const chunks = {
    search: vi.fn().mockResolvedValue(found),
    findByIds: vi.fn().mockResolvedValue(found),
  };
  const spaceCloud = { lockActiveForWrite: vi.fn().mockResolvedValue(true) };
  const uow = { run: vi.fn((work: () => Promise<unknown>) => work()) };
  const llm = new FakeLanguageModel();
  const embedder = new FakeEmbedder();
  const composer = new BrainComposerImpl(
    catalog as unknown as AgentToolCatalog,
    policies as unknown as AgentPolicyReader,
    counter as unknown as BrainStepCounter,
    budget as unknown as AiBudget,
    embedder,
    chunks as never,
    spaceCloud as unknown as SpaceCloud,
    llm,
    new AiPricing(),
    { now: vi.fn().mockResolvedValue(NOW) } as unknown as ResponderClock,
    uow as unknown as UnitOfWork,
  );
  const request: BrainStepRequest = {
    messageId: view.messageId,
    stepIndex: 0,
    history: [
      {
        id: view.messageId,
        author: 'person',
        authorUserId: view.authorUserId,
        text: QUESTION,
      },
    ],
    turns: [],
  };
  return {
    view,
    request,
    composer,
    catalog,
    counter,
    budget,
    chunks,
    spaceCloud,
    llm,
    embedder,
    found,
    reservation,
  };
}

describe('BrainComposerImpl', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers no pc tool when the recorded author is not the hub owner, whatever the history claims (Review Focus 1)', async () => {
    const t = setup({ author: OTHER });
    // The agent lies: the history says the owner asked.
    t.request.history[0]!.authorUserId = OWNER;
    t.llm.enqueue({
      text: 'tentando',
      toolCalls: [{ id: 'c1', name: llmToolName(erp.name), input: {} }],
    });
    t.llm.enqueue({ text: 'Só posso responder com conhecimento.' });
    const res = await t.composer.compose(t.view, t.request);
    expect(t.catalog.toolsOf).not.toHaveBeenCalled();
    expect(t.llm.calls[0]!.tools ?? []).toEqual([]);
    // The call to a tool that was never offered never comes out.
    expect(res).toEqual({
      kind: 'final',
      text: 'Só posso responder com conhecimento.',
      policyVersion: 7,
    });
  });

  it('offers the catalog ∩ the policy to the owner and returns the calls with their effect', async () => {
    const t = setup();
    t.llm.enqueue({
      text: 'Vou consultar.',
      toolCalls: [
        { id: 'c1', name: llmToolName(erp.name), input: { pedido: 42 } },
      ],
    });
    const res = await t.composer.compose(t.view, t.request);
    expect(t.catalog.toolsOf).toHaveBeenCalledWith(t.view.hubId);
    expect(t.llm.calls[0]!.tools!.map((x) => x.name)).toEqual([
      llmToolName(erp.name),
    ]);
    expect(res).toEqual({
      kind: 'tools',
      text: 'Vou consultar.',
      toolCalls: [
        { id: 'c1', name: erp.name, input: { pedido: 42 }, effect: 'allow' },
      ],
      policyVersion: 7,
    });
    // One model call: the route paid its slot; the composer consumed none.
    expect(t.counter.consume).not.toHaveBeenCalled();
    expect(t.budget.tryReserve).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, kind: 'agent' }),
    );
    expect(t.budget.settle).toHaveBeenCalledTimes(1);
    expect(t.counter.addCost).toHaveBeenCalledWith(t.view, expect.any(BigInt));
  });

  it('retrieves on the first call of the message and records only the chunk ids', async () => {
    const t = setup();
    await t.composer.compose(t.view, t.request);
    expect(t.embedder.calls).toEqual([{ count: 1, kind: 'query' }]);
    expect(t.chunks.search).toHaveBeenCalledTimes(1);
    expect(t.counter.recordChunkIds).toHaveBeenCalledWith(
      t.view,
      t.found.map((c) => c.id),
    );
    expect(t.llm.calls[0]!.system).toContain(
      'O prazo do contrato é de 12 meses.',
    );
  });

  it('a later step re-reads the stored chunks by id, without embedding', async () => {
    const ids = [newId()];
    const t = setup({ storedChunkIds: ids });
    await t.composer.compose(t.view, { ...t.request, stepIndex: 1 });
    expect(t.embedder.calls).toEqual([]);
    expect(t.chunks.search).not.toHaveBeenCalled();
    expect(t.chunks.findByIds).toHaveBeenCalledWith(ORG, t.view.spaceId, ids);
    expect(t.counter.recordChunkIds).not.toHaveBeenCalled();
    expect(t.llm.calls[0]!.system).toContain(
      'O prazo do contrato é de 12 meses.',
    );
  });

  it('the space left the active cloud before the chunks are read: 422 cloud-not-active, no model call', async () => {
    const t = setup();
    t.spaceCloud.lockActiveForWrite.mockResolvedValue(false);
    await expect(t.composer.compose(t.view, t.request)).rejects.toMatchObject({
      code: 'cloud-not-active',
    });
    expect(t.chunks.search).not.toHaveBeenCalled();
    expect(t.llm.calls).toHaveLength(0);
  });

  it('a budget refusal answers refused without calling the model', async () => {
    const t = setup();
    const resetsAt = new Date('2026-12-01T00:00:00.000Z');
    t.budget.tryReserve.mockResolvedValue({ refusal: { resetsAt } });
    const res = await t.composer.compose(t.view, t.request);
    expect(res).toEqual({
      kind: 'refused',
      reason: 'ai-budget-exceeded',
      resetsAt: resetsAt.toISOString(),
    });
    expect(t.llm.calls).toHaveLength(0);
    expect(t.embedder.calls).toHaveLength(0);
  });

  it('a dropped call is fed back as an error tool_result; the extra model call consumes a slot first', async () => {
    const t = setup();
    t.llm.enqueue({
      toolCalls: [{ id: 'h1', name: 'shell_exec', input: { cmd: 'x' } }],
    });
    t.llm.enqueue({ text: 'Não tenho essa ferramenta.' });
    const res = await t.composer.compose(t.view, t.request);
    expect(res).toEqual({
      kind: 'final',
      text: 'Não tenho essa ferramenta.',
      policyVersion: 7,
    });
    expect(t.counter.consume).toHaveBeenCalledTimes(1);
    const second = t.llm.calls[1]!.messages;
    expect(second.at(-1)).toEqual({
      role: 'user',
      content: [
        expect.objectContaining({
          type: 'tool_result',
          toolUseId: 'h1',
          isError: true,
        }),
      ],
    });
  });

  it("'limit' in the middle of the step returns the last model text as final", async () => {
    const t = setup();
    t.counter.consume.mockResolvedValue('limit');
    t.llm.enqueue({
      text: 'Quase lá',
      toolCalls: [{ id: 'h1', name: 'shell_exec', input: {} }],
    });
    const res = await t.composer.compose(t.view, t.request);
    expect(res).toEqual({ kind: 'final', text: 'Quase lá', policyVersion: 7 });
    expect(t.llm.calls).toHaveLength(1);
  });
});
