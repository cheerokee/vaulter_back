import { Injectable, Logger } from '@nestjs/common';
import { AgentPolicyReader } from '../../../agents/application/agent-policy-reader.js';
import { AgentToolCatalog } from '../../../agents/application/agent-tool-catalog.js';
import type { AgentTurnView } from '../../../conversations/application/agent-turn.js';
import {
  CloudConversationExecutor,
  MAX_CLOUD_HISTORY_MESSAGES,
} from '../../../conversations/application/cloud-conversation-executor.js';
import { UnitOfWork } from '../../../shared/infra/db/unit-of-work.js';
import { SpaceCloud } from '../../../spaces/application/space-cloud.js';
import { AiPricing } from '../../domain/ai-pricing.js';
import type { AiReservation } from '../../domain/ai-usage.js';
import {
  cloudNotActive,
  type BrainContentBlock,
  type BrainDocumentOutcome,
  type BrainStepRequest,
  type BrainStepResponse,
} from '../../domain/brain-step.js';
import type { HistoryMessage } from '../../domain/document-gate.js';
import {
  CloudChunkRepository,
  type ChunkHit,
} from '../../domain/indexing.repositories.js';
import {
  ANSWER_TEXT_MAX_BYTES,
  RESPONDER_CONTEXT_CHUNKS,
  RESPONDER_MESSAGE_MAX_CHARS,
} from '../../domain/responder.js';
import { AiBudget } from '../ai-budget.js';
import { CloudCipher } from '../ports/cloud-cipher.js';
import { Embedder } from '../ports/embedder.js';
import {
  LanguageModel,
  LanguageModelError,
  type LlmContentBlock,
  type LlmMessage,
  type LlmResult,
  type LlmTool,
  type LlmToolCall,
} from '../ports/language-model.js';
import { ServerKeyring } from '../ports/server-keyring.js';
import { RESPONDER_TOOLS } from '../responder/antares-prompt.js';
import { CloudDocumentWriter } from '../responder/cloud-document-writer.js';
import { ResponderClock } from '../responder/responder-clock.js';
import {
  cutUtf8,
  decryptHistory,
  embedQuestion,
  runDocumentTool,
  Spend,
  toLlmMessages,
  type ServerKeys,
} from '../responder/responder-shared.js';
import {
  llmToolName,
  markCalls,
  offeredDefs,
  toLlmTools,
} from './agent-tool-offer.js';
import {
  ANTARES_AGENT_PROMPT_VERSION,
  antaresAgentSystemPrompt,
  escapeData,
  spaceDataBlock,
  toolResultAsData,
} from './antares-agent-prompt.js';
import { BrainStepCounter } from './brain-step-counter.js';
import { BrainComposer } from './brain-step.use-case.js';

/** Fixed texts (no model involved), pt-BR like the app. */
export const AGENT_STEP_FAILED_TEXT =
  'Não consegui formular uma resposta agora. Tente de novo em instantes.';
export const NOT_OFFERED_RESULT =
  'Recusada: esta ferramenta não foi oferecida neste passo (ou a política da organização nega estes argumentos). Nada foi executado. Use só as ferramentas oferecidas.';
export const NOT_RUN_RESULT =
  'Não executada: esta rodada tinha uma chamada recusada. Chame de novo só as ferramentas oferecidas.';
export const NOT_RUN_WITH_DOCUMENT_RESULT =
  'Não executada: ferramentas do PC não rodam na mesma rodada de uma ferramenta de documento. Chame de novo, se ainda precisar.';
/** The document tools: run on the back inside the step, never sent to the agent. */
const DOCUMENT_TOOL_NAMES: ReadonlySet<string> = new Set(
  RESPONDER_TOOLS.map((t) => t.name),
);
const NO_TOOLS_RESULT =
  'Nenhuma ferramenta do PC está disponível nesta pergunta: nada foi executado. Responda só com texto.';

/** Output tokens of one model call (a tool call may carry a whole file to write). */
export const AGENT_MAX_OUTPUT_TOKENS = 4_000;
/** Characters per token in the estimate (over-estimate, like the responder's). */
const CHARS_PER_TOKEN = 2;
/** The fixed part of the system prompt, in characters (over-estimate). */
const SYSTEM_PROMPT_CHARS = 8_000;

type Paid<T> = { value: T } | { refusal: { resetsAt: Date } };

// O compositor do passo do cérebro do agente do PC (spec pc-agent §5.3, "O que o back faz"; Task 11). Sem estado e sem
// guardar conteúdo: tudo em claro só em memória. A cada passo:
// 1. oferta: catálogo do agente (`AgentToolCatalog.toolsOf(view.hubId)`) ∩ política ATUAL da organização
//    (`AgentPolicyReader.current`) para o DONO, sem as negadas, e SÓ quando o autor GRAVADO da mensagem
//    (`view.authorUserId`, nunca o `history`) é o dono (Review Focus 1). A versão da política sai em `policyVersion`
//    (Review Focus 3: cada passo recalcula);
// 2. cada chamada ao modelo: o orçamento antes (`AiBudget.tryReserve`, `kind: 'agent'`; recusado = `refused`, sem
//    chamar nada) e o acerto depois (`settle` + `BrainStepCounter.addCost`, ou `release` se nada foi chamado). A
//    primeira chamada do passo já foi contada pela rota; cada chamada ADICIONAL chama `consume` antes (`'limit'` = o
//    último texto do modelo como `final`);
// 3. trechos: só na primeira chamada da MENSAGEM (nenhum id guardado) a pergunta é embutida e buscada; os ids achados
//    vão para `agent_brain_steps.chunk_ids` e os passos seguintes releem por id (trecho apagado some). Antes de ler
//    trechos, o espaço é reconferido em `active_cloud` sob a trava dele (`SpaceCloud.lockActiveForWrite`, a mesma do
//    responder; desligou no meio = 422 `cloud-not-active`, sem chamar o modelo);
// 4. o modelo: prompt versionado (`antares-agent-prompt.ts`), histórico até `messageId` e os `turns` do agente. Uma
//    chamada a ferramenta não oferecida (ou negada pelos argumentos) é DESCARTADA (`markCalls`): nunca sai em
//    `toolCalls`; vira um `tool_result` de erro e o modelo é chamado de novo DENTRO do passo (Review Focus 2). Sai com
//    texto final ou com chamadas do PC (cada uma com o `effect` da ACL);
// 5. documentos (Task 12): com a nuvem de reserva ligada no assunto (`view.cloudReserve`) e o assunto ao alcance da
//    nuvem, o histórico é lido e decifrado PELO SERVIDOR (`CloudConversationExecutor.read` + cópias da chave do assunto
//    para o servidor, fora de qualquer transação; chaves apagadas logo depois) e é ELE que vai ao modelo (com as
//    propostas e os botões por extenso, como no responder), nunca o `history` do agente. `propose_document` /
//    `record_document` (`RESPONDER_TOOLS`, nomes reservados: nenhuma ferramenta do catálogo os toma) rodam aqui, com o
//    código do responder (`runDocumentTool`): a trava `confirmedProposal` confere a proposta (da nuvem ou do executor)
//    logo antes da mensagem e a recusa por botão contra esse histórico; grava em nome do autor GRAVADO da mensagem
//    (`memory.write`). Recusa ou falha = `tool_result` de erro e o modelo de novo (cada chamada extra passa por `consume`
//    e pelo orçamento); nunca saem em `toolCalls`. A proposta ou o documento gravado voltam na resposta
//    (`documentProposal` / `documentRecorded`) para o agente pôr na mensagem dele.
// Nada legível em log: só ids, contagens, versões e o tipo da saída.
@Injectable()
export class BrainComposerImpl extends BrainComposer {
  private readonly logger = new Logger(BrainComposerImpl.name);

  constructor(
    private readonly catalog: AgentToolCatalog,
    private readonly policies: AgentPolicyReader,
    private readonly counter: BrainStepCounter,
    private readonly budget: AiBudget,
    private readonly embedder: Embedder,
    private readonly chunks: CloudChunkRepository,
    private readonly spaceCloud: SpaceCloud,
    private readonly llm: LanguageModel,
    private readonly pricing: AiPricing,
    private readonly clock: ResponderClock,
    private readonly uow: UnitOfWork,
    private readonly executor: CloudConversationExecutor,
    private readonly keyring: ServerKeyring,
    private readonly cipher: CloudCipher,
    private readonly documents: CloudDocumentWriter,
  ) {
    super();
  }

  async compose(
    view: AgentTurnView,
    request: BrainStepRequest,
  ): Promise<BrainStepResponse> {
    // Review Focus 1: the recorded author of `messageId`, never anything the agent sent.
    const pcToolsAllowed = view.authorUserId === view.hubOwnerUserId;
    const policy = await this.policies.current(view.organizationId);
    const catalog = pcToolsAllowed
      ? await this.catalog.toolsOf(view.hubId)
      : [];
    // The document tools need the history decrypted by the server (never the agent's): reserve on and readable.
    const serverHistory = view.cloudReserve
      ? await this.serverHistory(view)
      : null;
    const docsOffered = serverHistory !== null;
    const { offered, collisions } = offeredDefs(
      catalog,
      policy.rules,
      view.hubOwnerUserId,
      pcToolsAllowed,
      DOCUMENT_TOOL_NAMES,
    );
    if (collisions > 0) {
      // Two catalog tools with the same model-safe name: neither is offered (only the count is logged).
      this.logger.warn(
        {
          organizationId: view.organizationId,
          messageId: view.messageId,
          collisions,
        },
        'brain step: colliding tool names not offered',
      );
    }
    const pcTools = toLlmTools(offered);
    const tools = docsOffered ? [...pcTools, ...RESPONDER_TOOLS] : pcTools;
    const question = serverHistory
      ? (serverHistory.find((m) => m.id === view.messageId)?.content.text ?? '')
      : questionOf(request);
    const storedChunkIds = await this.counter.chunkIdsOf(view);
    const messages = messagesOf(request, tools.length > 0, serverHistory);
    const stats = { calls: 0, dropped: 0, documentCalls: 0 };
    const docs: BrainDocumentOutcome = {};
    const done = (response: BrainStepResponse): BrainStepResponse => {
      this.logger.log(
        {
          organizationId: view.organizationId,
          spaceId: view.spaceId,
          conversationId: view.conversationId,
          messageId: view.messageId,
          stepIndex: request.stepIndex,
          promptVersion: ANTARES_AGENT_PROMPT_VERSION,
          policyVersion: policy.version,
          offered: tools.length,
          documentTools: docsOffered,
          calls: stats.calls,
          dropped: stats.dropped,
          documentCalls: stats.documentCalls,
          outcome: response.kind,
        },
        'brain step',
      );
      return response;
    };
    const final = (text: string): BrainStepResponse =>
      done({
        kind: 'final',
        text: cutUtf8(text.trim() || fallbackText(docs), ANSWER_TEXT_MAX_BYTES),
        policyVersion: policy.version,
        ...docs,
      });

    let system: string | undefined;
    let lastText = '';
    for (let n = 0; ; n++) {
      // The route paid for the first call; every additional one takes a slot first.
      if (n > 0 && (await this.counter.consume(view)) === 'limit') {
        return final(lastText);
      }
      const firstRetrieval = system === undefined && storedChunkIds === null;
      let paid: Paid<LlmResult>;
      try {
        paid = await this.paid(
          view,
          this.estimate(system, messages, tools, firstRetrieval, question),
          async (spend) => {
            if (system === undefined) {
              const chunks = await this.context(
                view,
                question,
                storedChunkIds,
                spend,
              );
              system = antaresAgentSystemPrompt({
                tools: pcTools,
                pcToolsAllowed,
                ...(docsOffered
                  ? {
                      documents: {
                        audience: await this.spaceCloud.audience(
                          view.organizationId,
                          view.spaceId,
                        ),
                      },
                    }
                  : {}),
                now: await this.clock.now(),
              });
              // The chunks are data: a delimited block in the first user turn, never the system prompt.
              prependData(messages, spaceDataBlock(chunks));
            }
            const result = await this.llm.complete({
              system,
              messages,
              ...(tools.length > 0 ? { tools } : {}),
              maxTokens: AGENT_MAX_OUTPUT_TOKENS,
            });
            spend.add(
              this.pricing.costMicroUsd(result.usage, result.model),
              result.usage,
            );
            return result;
          },
        );
      } catch (error) {
        // A model that cannot answer this (not worth retrying): a fixed text; anything else fails the step.
        if (error instanceof LanguageModelError && !error.retryable) {
          // Like the responder: the fixed text alone (a recorded document still says so).
          delete docs.documentProposal;
          return final(AGENT_STEP_FAILED_TEXT);
        }
        throw error;
      }
      if ('refusal' in paid) {
        return done({
          kind: 'refused',
          reason: 'ai-budget-exceeded',
          resetsAt: paid.refusal.resetsAt.toISOString(),
        });
      }
      stats.calls += 1;
      const result = paid.value;
      lastText = result.text;
      if (result.toolCalls.length === 0) return final(result.text);

      const docCalls = docsOffered
        ? result.toolCalls.filter((c) => DOCUMENT_TOOL_NAMES.has(c.name))
        : [];
      const { out, dropped } = markCalls(
        result.toolCalls.filter((c) => !docCalls.includes(c)),
        offered,
        policy.rules,
        view.hubOwnerUserId,
      );
      if (dropped.length === 0 && docCalls.length === 0) {
        const text = result.text.trim();
        return done({
          kind: 'tools',
          ...(text ? { text: cutUtf8(text, ANSWER_TEXT_MAX_BYTES) } : {}),
          toolCalls: out,
          policyVersion: policy.version,
          ...docs,
        });
      }
      // Review Focus 2: a dropped call never reaches the agent; the model hears it was refused, in this same step. The
      // document tools run here (outside any transaction and any reservation) and their results go back the same way.
      stats.dropped += dropped.length;
      stats.documentCalls += docCalls.length;
      const results = new Map<LlmToolCall, ToolResult>();
      for (const call of docCalls) {
        const outcome = await runDocumentTool(
          { documents: this.documents, clock: this.clock },
          view,
          { id: view.messageId, authorUserId: view.authorUserId },
          serverHistory ?? [],
          call,
          ['cloud', 'hub'],
        );
        if (outcome.recorded) {
          docs.documentRecorded = outcome.recorded;
          delete docs.documentProposal;
        } else if (outcome.proposal && !docs.documentRecorded) {
          docs.documentProposal = outcome.proposal;
        }
        results.set(call, {
          content: JSON.stringify(outcome.result),
          isError: outcome.isError,
        });
      }
      const notRun =
        dropped.length > 0 ? NOT_RUN_RESULT : NOT_RUN_WITH_DOCUMENT_RESULT;
      for (const call of result.toolCalls) {
        if (results.has(call)) continue;
        results.set(call, {
          content: dropped.includes(call) ? NOT_OFFERED_RESULT : notRun,
          isError: true,
        });
      }
      feedBack(messages, result, results, tools.length > 0);
    }
  }

  /**
   * The conversation's history decrypted by the SERVER (the cloud reserve's copies of its key), up to `messageId`, or
   * null when out of the cloud's reach (reserve or space switched off) or the message is not in the read window: then
   * no document tool is offered. The read is a short transaction of its own; the keys are opened (KMS-backed keyring)
   * and the messages decrypted outside it, and the keys are zeroed right after.
   */
  private async serverHistory(
    view: AgentTurnView,
  ): Promise<HistoryMessage[] | null> {
    const read = await this.executor.read(
      view.organizationId,
      view.spaceId,
      view.conversationId,
      MAX_CLOUD_HISTORY_MESSAGES,
    );
    if (!read || !read.messages.some((m) => m.id === view.messageId)) {
      return null;
    }
    const keys: ServerKeys = new Map();
    try {
      for (const copy of read.serverKeyCopies) {
        keys.set(
          copy.keyVersion,
          await this.keyring.openSealed(copy.wrappedKey),
        );
      }
      return await decryptHistory(
        { cipher: this.cipher, logger: this.logger },
        read,
        view.messageId,
        keys,
      );
    } finally {
      for (const k of keys.values()) k.fill(0);
    }
  }

  /** One paid model call: reserve before, settle (and add to the message's row) or release after. */
  private async paid<T>(
    view: AgentTurnView,
    estimatedMicroUsd: bigint,
    work: (spend: Spend) => Promise<T>,
  ): Promise<Paid<T>> {
    const reserved = await this.budget.tryReserve({
      organizationId: view.organizationId,
      spaceId: view.spaceId,
      kind: 'agent',
      estimatedMicroUsd,
    });
    if ('refusal' in reserved) return { refusal: reserved.refusal };
    const spend = new Spend();
    try {
      return { value: await work(spend) };
    } finally {
      await this.close(view, reserved.reservation, spend);
    }
  }

  /**
   * The chunks of the prompt. First call of the message (no ids stored): embed the question (network, outside any
   * transaction), then search; later: re-read the stored ids. The read happens in one short transaction that first
   * locks the space `FOR SHARE` and re-checks `active_cloud` (switched off since the route's check = 422
   * `cloud-not-active`, before any model call).
   */
  private async context(
    view: AgentTurnView,
    question: string,
    storedChunkIds: string[] | null,
    spend: Spend,
  ): Promise<ChunkHit[]> {
    const { organizationId, spaceId } = view;
    const embedded =
      storedChunkIds === null
        ? await embedQuestion(
            { embedder: this.embedder, pricing: this.pricing },
            question,
            spend,
          )
        : null;
    const hits = await this.uow.run(async () => {
      if (
        !(await this.spaceCloud.lockActiveForWrite(organizationId, spaceId))
      ) {
        throw cloudNotActive();
      }
      if (storedChunkIds !== null) {
        return this.chunks.findByIds(organizationId, spaceId, storedChunkIds);
      }
      if (!embedded) return [];
      return this.chunks.search(
        organizationId,
        spaceId,
        embedded.vector,
        embedded.model,
        RESPONDER_CONTEXT_CHUNKS,
      );
    });
    if (storedChunkIds === null) {
      await this.counter.recordChunkIds(
        view,
        hits.map((h) => h.id),
      );
    }
    return hits;
  }

  /**
   * Over-estimate of one model call: what is sent (system prompt, messages, tools) plus the full output and, on the
   * message's first call, the question's embedding. The body of the request stands where the responder counts the
   * encrypted history.
   */
  private estimate(
    system: string | undefined,
    messages: LlmMessage[],
    tools: LlmTool[],
    withEmbedding: boolean,
    question: string,
  ): bigint {
    const toolsChars = JSON.stringify(tools).length;
    const systemChars =
      system?.length ??
      SYSTEM_PROMPT_CHARS + RESPONDER_CONTEXT_CHUNKS * 1_000 + toolsChars;
    const chars = systemChars + JSON.stringify(messages).length + toolsChars;
    let cost = this.pricing.costMicroUsd(
      {
        inputTokens: Math.ceil(chars / CHARS_PER_TOKEN),
        outputTokens: AGENT_MAX_OUTPUT_TOKENS,
      },
      this.llm.model,
    );
    if (withEmbedding) {
      cost += this.pricing.costMicroUsd(
        {
          inputTokens: Math.ceil(
            Math.min(question.length, RESPONDER_MESSAGE_MAX_CHARS) /
              CHARS_PER_TOKEN,
          ),
          outputTokens: 0,
        },
        this.embedder.model,
      );
    }
    return cost;
  }

  /** Settles what was spent, or gives the reservation back when nothing was called. Never masks the outcome. */
  private async close(
    view: AgentTurnView,
    reservation: AiReservation,
    spend: Spend,
  ): Promise<void> {
    try {
      if (spend.calls === 0) {
        await this.budget.release(reservation);
        return;
      }
      await this.budget.settle(reservation, {
        model: this.llm.model,
        inputTokens: spend.inputTokens,
        outputTokens: spend.outputTokens,
        costMicroUsd: spend.costMicroUsd,
      });
      await this.counter.addCost(view, spend.costMicroUsd);
    } catch (error) {
      this.logger.warn(
        {
          organizationId: view.organizationId,
          messageId: view.messageId,
          reservationId: reservation.id,
          calls: spend.calls,
          costMicroUsd: spend.costMicroUsd.toString(),
          error: error instanceof Error ? error.name : 'unknown',
        },
        'brain step: budget not settled (the reservation expires on its own)',
      );
    }
  }
}

type ToolResult = { content: string; isError: boolean };

/** What the answer says when the model ended with no text (like the responder: what the document tools did). */
function fallbackText(docs: BrainDocumentOutcome): string {
  if (docs.documentRecorded) {
    return `Gravei o documento "${docs.documentRecorded.title}" no espaço.`;
  }
  if (docs.documentProposal) {
    return `Posso gravar o documento "${docs.documentProposal.title}" no espaço?`;
  }
  return AGENT_STEP_FAILED_TEXT;
}

/**
 * The question without the server's history (no cloud reserve): the text of `messageId` in the history the agent sent
 * ('' when it is missing: no retrieval).
 */
function questionOf(request: BrainStepRequest): string {
  return request.history.find((m) => m.id === request.messageId)?.text ?? '';
}

/**
 * The model's messages: the history up to `messageId` (as the responder turns it into turns), then the agent's
 * previous turns of this answer. The history is the server-decrypted one when there is one (`serverHistory`, already
 * cut at `messageId`, with proposals and button decisions spelled out), else the one the agent sent. Tool names in the
 * turns become the model-safe names; with no tool offered, tool blocks become text (the model APIs refuse tool blocks
 * without tools).
 */
function messagesOf(
  request: BrainStepRequest,
  toolsOffered: boolean,
  serverHistory: readonly HistoryMessage[] | null,
): LlmMessage[] {
  const upTo = request.history.findIndex((m) => m.id === request.messageId);
  const slice =
    upTo >= 0 ? request.history.slice(0, upTo + 1) : request.history;
  const history: readonly HistoryMessage[] =
    serverHistory ??
    slice.map((m) => ({
      id: m.id,
      author: m.author,
      authorUserId: m.authorUserId ?? null,
      content: { text: m.text },
    }));
  const messages = toLlmMessages(history);
  for (const turn of request.turns) {
    push(messages, {
      role: turn.role,
      content: turn.content.map((b) => toLlmBlock(b, toolsOffered)),
    });
  }
  return messages;
}

function toLlmBlock(
  block: BrainContentBlock,
  toolsOffered: boolean,
): LlmContentBlock {
  if (block.type === 'tool_use') {
    return toolsOffered
      ? { ...block, name: llmToolName(block.name) }
      : {
          type: 'text',
          text: `[Ferramenta ${escapeData(block.name)} chamada]`,
        };
  }
  if (block.type === 'tool_result' && !toolsOffered) {
    return {
      type: 'text',
      text: toolResultAsData(block.content, block.isError === true),
    };
  }
  return block;
}

/** Puts a data block at the start of the first user turn (or a user turn of its own when the messages start otherwise). */
function prependData(messages: LlmMessage[], data: string): void {
  const first = messages[0];
  if (!first || first.role !== 'user') {
    messages.unshift({ role: 'user', content: data });
    return;
  }
  const rest: LlmContentBlock[] =
    typeof first.content === 'string'
      ? [{ type: 'text', text: first.content }]
      : first.content;
  first.content = [{ type: 'text', text: data }, ...rest];
}

/** Appends a message, joining it to the last one when they have the same role (the model APIs want them alternating). */
function push(messages: LlmMessage[], message: LlmMessage): void {
  const last = messages[messages.length - 1];
  if (!last || last.role !== message.role) {
    messages.push(message);
    return;
  }
  const blocks = (c: LlmMessage['content']): LlmContentBlock[] =>
    typeof c === 'string' ? [{ type: 'text', text: c }] : c;
  last.content = [...blocks(last.content), ...blocks(message.content)];
}

/**
 * The model's turn with calls resolved inside the step (a dropped call, a document tool), and the results it hears back
 * (`results`: every call of the turn answered).
 */
function feedBack(
  messages: LlmMessage[],
  result: LlmResult,
  results: ReadonlyMap<LlmToolCall, ToolResult>,
  toolsOffered: boolean,
): void {
  if (!toolsOffered) {
    push(messages, {
      role: 'assistant',
      content: result.text.trim() || '[tentou chamar uma ferramenta]',
    });
    push(messages, { role: 'user', content: NO_TOOLS_RESULT });
    return;
  }
  push(messages, {
    role: 'assistant',
    content: [
      ...(result.text ? [{ type: 'text' as const, text: result.text }] : []),
      ...result.toolCalls.map((c): LlmContentBlock => ({
        type: 'tool_use',
        ...c,
      })),
    ],
  });
  push(messages, {
    role: 'user',
    content: result.toolCalls.map((c): LlmContentBlock => ({
      type: 'tool_result',
      toolUseId: c.id,
      ...results.get(c)!,
    })),
  });
}
