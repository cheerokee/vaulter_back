import { Injectable, Logger } from '@nestjs/common';
import {
  CloudConversationExecutor,
  MAX_CLOUD_HISTORY_MESSAGES,
  type CloudConversationRead,
  type CloudMessageView,
} from '../../../conversations/application/cloud-conversation-executor.js';
import { CloudAnswerNotOwnedError } from '../../../conversations/application/send-message.use-case.js';
import { DomainError } from '../../../shared/domain/errors.js';
import { SpaceCloud } from '../../../spaces/application/space-cloud.js';
import { AiPricing } from '../../domain/ai-pricing.js';
import type { AiReservation } from '../../domain/ai-usage.js';
import type { HistoryMessage } from '../../domain/document-gate.js';
import { CloudChunkRepository } from '../../domain/indexing.repositories.js';
import {
  encodeMessage,
  type DocumentProposal,
  type MessageContent,
} from '../../domain/message-plaintext.js';
import {
  ANSWER_TEXT_MAX_BYTES,
  answerIdFor,
  CLOUD_GIVE_UP_RETRY_AFTER_MS,
  budgetNoticeIdFor,
  DOCUMENT_MAX_BYTES,
  nextResponderStep,
  RESPONDER_CONTEXT_CHUNKS,
  RESPONDER_HISTORY_MESSAGES,
  RESPONDER_MAX_MESSAGES_PER_RUN,
  RESPONDER_MAX_OUTPUT_TOKENS,
  RESPONDER_MAX_TURNS,
  RESPONDER_MESSAGE_MAX_CHARS,
} from '../../domain/responder.js';
import { AiBudget } from '../ai-budget.js';
import { CloudCipher } from '../ports/cloud-cipher.js';
import { Embedder } from '../ports/embedder.js';
import {
  LanguageModel,
  LanguageModelError,
  type LlmContentBlock,
} from '../ports/language-model.js';
import { ServerKeyring } from '../ports/server-keyring.js';
import type { JobContext } from '../../../shared/application/job-queue.js';
import {
  ANTARES_CLOUD_PROMPT_VERSION,
  antaresCloudSystemPrompt,
  RESPONDER_TOOLS,
} from './antares-prompt.js';
import { CloudDocumentWriter } from './cloud-document-writer.js';
import {
  CloudResponderQueue,
  type AnswerConversationPayload,
} from './cloud-responder-queue.js';
import { ResponderClock } from './responder-clock.js';
import {
  cutUtf8,
  decryptHistory,
  retrieve,
  runDocumentTool,
  Spend,
  toLlmMessages,
  type ServerKeys,
} from './responder-shared.js';

/** Fixed, non-sensitive texts of the cloud (no model involved). pt-BR, like the app. */
export const BUDGET_NOTICE_TEXT =
  'Não consegui responder pela nuvem: o orçamento de IA da organização para este mês acabou. Quando o Hub estiver ligado, ele responde normalmente; um administrador da organização pode pedir o aumento do orçamento.';
export const ANSWER_FAILED_TEXT =
  'Não consegui formular uma resposta pela nuvem agora. Tente de novo em instantes, ou espere o Hub.';

/** Upper estimate (in characters) of what tool results add to the prompt in one answer (a document goes back and forth). */
const TOOL_ROUND_TRIP_CHARS = 2 * DOCUMENT_MAX_BYTES;
/** Characters per token in the estimate (over-estimate, like the indexing's). */
const CHARS_PER_TOKEN = 2;

type StepOutcome = 'continue' | 'stop';

type Keys = ServerKeys;

// A nuvem como executor de reserva respondendo um assunto (spec active-cloud §4.3; Task 7 do plano). UMA tarefa por
// assunto (`CloudResponderQueue`), mensagens EM ORDEM: a nuvem nunca pega a segunda antes de responder a primeira, e uma
// execução que caiu termina a mensagem que ela mesma pegou (`nextResponderStep`). Cada mensagem:
// 1. leitura curta (`CloudConversationExecutor.read`, uma transação sem trava): assunto, cópias da chave do servidor e o
//    histórico DO PRÓPRIO assunto (nunca outro: Review Focus 5);
// 2. ainda é do Hub (menos de 30 s, sem "responder pela nuvem", com Hub executor) = reagenda para a hora certa e para;
// 3. orçamento ANTES de pegar (`AiBudget.tryReserve`, transação própria): recusado = a mensagem fica `pending` para o Hub
//    (que segue normal) e o assunto recebe UM aviso fixo da nuvem por fila de pendentes (id derivado da mais antiga:
//    nada de um aviso por mensagem), sem custo nenhum;
// 4. `ack` atômico como executor nuvem (o primeiro ack vale: Hub antes = `taken`, a reserva volta e a nuvem desiste sem
//    gastar nada; Review Focus 2);
// 5. FORA de qualquer transação: abre as chaves do assunto (cópias do servidor), decifra o histórico, embeda a pergunta,
//    busca os trechos DO ESPAÇO (pgvector, só deste espaço e do modelo do embedder), monta o prompt versionado do Antares
//    (com o público do espaço para o alerta de confidencialidade) e conversa com o modelo (até 4 turnos; ferramentas
//    `propose_document` / `record_document`, esta só grava depois da confirmação, conferida pelo servidor:
//    `confirmedProposal`), somando o custo;
// 6. grava a resposta cifrada com a chave do assunto (versão atual) como mensagem da nuvem, com id DERIVADO da pergunta
//    (`answerIdFor`: duas execuções nunca dão duas respostas) e a pergunta reconferida sob a trava do assunto (ainda
//    confirmada pela nuvem; o desligar/reserva caindo no meio = nada gravado);
// 7. acerta o orçamento com o gasto real (ou devolve a reserva, se nada foi chamado).
// Nada legível vai para log (só ids, contagens, códigos e a versão do prompt). Chaves e textos em claro são apagados.
@Injectable()
export class AnswerConversationJob {
  private readonly logger = new Logger(AnswerConversationJob.name);

  constructor(
    private readonly executor: CloudConversationExecutor,
    private readonly keyring: ServerKeyring,
    private readonly cipher: CloudCipher,
    private readonly embedder: Embedder,
    private readonly chunks: CloudChunkRepository,
    private readonly spaceCloud: SpaceCloud,
    private readonly llm: LanguageModel,
    private readonly pricing: AiPricing,
    private readonly budget: AiBudget,
    private readonly documents: CloudDocumentWriter,
    private readonly queue: CloudResponderQueue,
    private readonly clock: ResponderClock,
  ) {}

  /**
   * `job.lastAttempt`: no pg-boss retry follows a failure of this run. A retryable failure (embeddings, model, KMS...)
   * then gives the message the cloud holds back (`CloudConversationExecutor.release`: pending again, the Hub's 30 s
   * restart and its ack works) and schedules a fresh look at the conversation in `CLOUD_GIVE_UP_RETRY_AFTER_MS`; the
   * error still fails this job.
   */
  async run(
    payload: AnswerConversationPayload,
    job?: Pick<JobContext, 'lastAttempt'>,
  ): Promise<void> {
    try {
      for (let n = 0; n < RESPONDER_MAX_MESSAGES_PER_RUN; n++) {
        if ((await this.step(payload)) === 'stop') return;
      }
      // More to do: a fresh job (keeps one run bounded).
      await this.queue.now(payload);
    } catch (error) {
      if (job?.lastAttempt) await this.giveUp(payload);
      throw error;
    }
  }

  /** Retries exhausted: the held message goes back to pending and the conversation is looked at again later. */
  private async giveUp(p: AnswerConversationPayload): Promise<void> {
    try {
      const released = await this.executor.release(
        p.organizationId,
        p.spaceId,
        p.conversationId,
      );
      await this.queue.later(p, CLOUD_GIVE_UP_RETRY_AFTER_MS / 1000);
      this.logger.warn(
        { ...p, released: released.length },
        'cloud answer given up: message back to pending',
      );
    } catch (error) {
      // The original failure is what the job reports; this one only by its type (never a message).
      this.logger.warn(
        {
          ...p,
          error: error instanceof DomainError ? error.code : 'unknown',
        },
        'cloud answer: give-up failed',
      );
    }
  }

  private async step(p: AnswerConversationPayload): Promise<StepOutcome> {
    const read = await this.executor.read(
      p.organizationId,
      p.spaceId,
      p.conversationId,
      MAX_CLOUD_HISTORY_MESSAGES,
    );
    // Out of reach (reserve off, space off, gone) or a rotation pending (the `key_rotated` signal brings it back).
    if (!read || read.conversation.keyRotationRequired) return 'stop';
    const now = await this.clock.now();
    const step = nextResponderStep({
      messages: read.messages,
      conversationCloudAnswer: read.conversation.cloudAnswer,
      hasExecutorHub: read.conversation.executorHubId !== null,
      now,
    });
    if (step.kind === 'idle') return 'stop';
    if (step.kind === 'wait') {
      await this.queue.later(
        p,
        Math.ceil((step.at.getTime() - now.getTime()) / 1000),
      );
      return 'stop';
    }
    const target = read.messages.find((m) => m.id === step.message.id)!;

    const reserved = await this.budget.tryReserve({
      organizationId: p.organizationId,
      spaceId: p.spaceId,
      kind: 'answer',
      estimatedMicroUsd: this.estimate(read, target),
    });
    if ('refusal' in reserved) {
      if (step.resume) {
        // Already the cloud's (a crashed run): the notice IS its answer, so the person is not left waiting. Not
        // delivered (space full, no server copy...) = stop: the next signal tries once more, never a loop.
        return this.sendFixed(p, read, answerIdFor(target.id), target.id, {
          text: BUDGET_NOTICE_TEXT,
          notice: 'ai-budget-exceeded',
        });
      }
      // Not taken: it stays pending for the Hub. One notice per backlog (derived from the oldest pending message).
      const noticeId = budgetNoticeIdFor(target.id);
      if (!read.messages.some((m) => m.id === noticeId)) {
        await this.sendFixed(p, read, noticeId, undefined, {
          text: BUDGET_NOTICE_TEXT,
          notice: 'ai-budget-exceeded',
        });
      }
      this.logger.log(
        { ...p, messageId: target.id, reason: 'ai-budget-exceeded' },
        'cloud answer skipped',
      );
      return 'stop';
    }
    const reservation = reserved.reservation;
    if (!step.resume) {
      const ack = await this.executor.ack(
        p.organizationId,
        p.spaceId,
        p.conversationId,
        target.id,
      );
      if (ack !== 'acked') {
        await this.budget.release(reservation);
        return ack === 'taken' ? 'continue' : 'stop';
      }
    }
    return this.answer(p, read, target, reservation);
  }

  /** Steps 5–7 for a message the cloud holds. */
  private async answer(
    p: AnswerConversationPayload,
    read: CloudConversationRead,
    target: CloudMessageView,
    reservation: AiReservation,
  ): Promise<StepOutcome> {
    const spend = new Spend();
    const keys: Keys = new Map();
    let outcome: StepOutcome = 'continue';
    try {
      for (const copy of read.serverKeyCopies) {
        keys.set(
          copy.keyVersion,
          await this.keyring.openSealed(copy.wrappedKey),
        );
      }
      const history = await decryptHistory(
        {
          cipher: this.cipher,
          logger: this.logger,
          label: 'cloud answer: history messages skipped',
        },
        read,
        target.id,
        keys,
      );
      let content: MessageContent;
      try {
        content = await this.compose(p, read, target, history, spend);
      } catch (error) {
        if (error instanceof LanguageModelError && !error.retryable) {
          content = { text: ANSWER_FAILED_TEXT };
        } else {
          throw error;
        }
      }
      outcome = await this.deliver(p, read, target, keys, content);
      this.logger.log(
        {
          ...p,
          messageId: target.id,
          promptVersion: ANTARES_CLOUD_PROMPT_VERSION,
          calls: spend.calls,
          inputTokens: spend.inputTokens,
          outputTokens: spend.outputTokens,
          delivered: outcome === 'continue',
        },
        'cloud answer',
      );
      return outcome;
    } finally {
      for (const k of keys.values()) k.fill(0);
      await this.close(reservation, spend);
    }
  }

  /** Steps 5: retrieval, prompt and the tool loop. Returns the answer's content. */
  private async compose(
    p: AnswerConversationPayload,
    read: CloudConversationRead,
    target: CloudMessageView,
    history: HistoryMessage[],
    spend: Spend,
  ): Promise<MessageContent> {
    const question = history.find((m) => m.id === target.id);
    if (!question) return { text: ANSWER_FAILED_TEXT };
    const hits = await retrieve(
      { embedder: this.embedder, pricing: this.pricing, chunks: this.chunks },
      p,
      question.content.text,
      spend,
    );
    const system = antaresCloudSystemPrompt({
      audience: await this.spaceCloud.audience(p.organizationId, p.spaceId),
      chunks: hits,
      now: await this.clock.now(),
    });
    const messages = toLlmMessages(history);
    let proposal: DocumentProposal | undefined;
    let recorded: { fileId: string; title: string } | undefined;
    let text = '';
    for (let turn = 0; turn < RESPONDER_MAX_TURNS; turn++) {
      const result = await this.llm.complete({
        system,
        messages,
        tools: RESPONDER_TOOLS,
        maxTokens: RESPONDER_MAX_OUTPUT_TOKENS,
      });
      spend.add(
        this.pricing.costMicroUsd(result.usage, result.model),
        result.usage,
      );
      text = result.text;
      if (result.toolCalls.length === 0 || turn === RESPONDER_MAX_TURNS - 1) {
        break;
      }
      messages.push({
        role: 'assistant',
        content: [
          ...(result.text
            ? [{ type: 'text' as const, text: result.text }]
            : []),
          ...result.toolCalls.map((c): LlmContentBlock => ({
            type: 'tool_use',
            ...c,
          })),
        ],
      });
      const results: LlmContentBlock[] = [];
      for (const call of result.toolCalls) {
        const out = await runDocumentTool(
          { documents: this.documents, clock: this.clock },
          p,
          target,
          history,
          call,
        );
        if (out.proposal) proposal = out.proposal;
        if (out.recorded) recorded = out.recorded;
        results.push({
          type: 'tool_result',
          toolUseId: call.id,
          content: JSON.stringify(out.result),
          isError: out.isError,
        });
      }
      messages.push({ role: 'user', content: results });
    }
    // A last turn with tool calls only (dropped: no more turns) still says what the tools did.
    const fallback = recorded
      ? `Gravei o documento "${recorded.title}" no espaço.`
      : proposal
        ? `Posso gravar o documento "${proposal.title}" no espaço?`
        : ANSWER_FAILED_TEXT;
    const content: MessageContent = {
      text: cutUtf8(text.trim() || fallback, ANSWER_TEXT_MAX_BYTES),
    };
    if (recorded) content.documentRecorded = recorded;
    else if (proposal) content.documentProposal = proposal;
    return content;
  }

  /** Step 6: the answer, sealed with the current conversation key, as the cloud. */
  private async deliver(
    p: AnswerConversationPayload,
    read: CloudConversationRead,
    target: CloudMessageView,
    keys: Keys,
    content: MessageContent,
  ): Promise<StepOutcome> {
    return this.sendWithKeys(
      p,
      read,
      keys,
      answerIdFor(target.id),
      target.id,
      content,
    );
  }

  /** A fixed message of the cloud (budget notice): opens only the current key. `continue` only when delivered. */
  private async sendFixed(
    p: AnswerConversationPayload,
    read: CloudConversationRead,
    id: string,
    answering: string | undefined,
    content: MessageContent,
  ): Promise<StepOutcome> {
    const keys: Keys = new Map();
    try {
      const copy = read.serverKeyCopies.find(
        (c) => c.keyVersion === read.conversation.currentKeyVersion,
      );
      if (!copy) return 'stop';
      keys.set(copy.keyVersion, await this.keyring.openSealed(copy.wrappedKey));
      return await this.sendWithKeys(p, read, keys, id, answering, content);
    } finally {
      for (const k of keys.values()) k.fill(0);
    }
  }

  private async sendWithKeys(
    p: AnswerConversationPayload,
    read: CloudConversationRead,
    keys: Keys,
    id: string,
    answering: string | undefined,
    content: MessageContent,
  ): Promise<StepOutcome> {
    const keyVersion = read.conversation.currentKeyVersion;
    const key = keys.get(keyVersion);
    if (!key) return 'stop';
    const plaintext = encodeMessage(content);
    try {
      const blob = await this.cipher.sealMessage(
        key,
        {
          spaceId: p.spaceId,
          conversationId: p.conversationId,
          messageId: id,
          keyVersion,
        },
        plaintext,
      );
      await this.executor.send(
        p.organizationId,
        p.spaceId,
        p.conversationId,
        {
          id,
          keyVersion,
          encryptedBody: Buffer.from(blob).toString('base64url'),
          replacesMessageId: null,
        },
        answering,
      );
      return 'continue';
    } catch (error) {
      // Someone else's turn now (another run answered it, the message went back to the queue, the reserve or the space
      // went off, the key must rotate first): nothing to write. The key rotation signal brings the message back.
      if (
        error instanceof CloudAnswerNotOwnedError ||
        (error instanceof DomainError &&
          [
            'message-id-conflict',
            'conversation-not-found',
            'conversation-key-rotation-required',
            'conversation-key-version-stale',
            'space-storage-full',
          ].includes(error.code))
      ) {
        this.logger.log(
          { ...p, messageId: id, reason: error.code },
          'cloud message not delivered',
        );
        return 'stop';
      }
      throw error;
    } finally {
      plaintext.fill(0);
    }
  }

  /** Over-estimate of one answer: every turn re-sends the prompt, plus tool round trips and the query embedding. */
  private estimate(
    read: CloudConversationRead,
    target: CloudMessageView,
  ): bigint {
    const upTo = read.messages.findIndex((m) => m.id === target.id);
    const historyChars = read.messages
      .slice(Math.max(0, upTo + 1 - RESPONDER_HISTORY_MESSAGES), upTo + 1)
      .reduce((sum, m) => sum + m.encryptedBody.length, 0);
    const promptChars =
      historyChars +
      RESPONDER_CONTEXT_CHUNKS * 1_000 +
      8_000 + // system prompt
      TOOL_ROUND_TRIP_CHARS;
    const inputTokens =
      RESPONDER_MAX_TURNS * Math.ceil(promptChars / CHARS_PER_TOKEN);
    const outputTokens = RESPONDER_MAX_TURNS * RESPONDER_MAX_OUTPUT_TOKENS;
    return (
      this.pricing.costMicroUsd({ inputTokens, outputTokens }, this.llm.model) +
      this.pricing.costMicroUsd(
        {
          inputTokens: Math.ceil(
            Math.min(target.encryptedBody.length, RESPONDER_MESSAGE_MAX_CHARS) /
              CHARS_PER_TOKEN,
          ),
          outputTokens: 0,
        },
        this.embedder.model,
      )
    );
  }

  /** Settles what was spent, or gives the reservation back when nothing was called. Never masks the outcome. */
  private async close(reservation: AiReservation, spend: Spend): Promise<void> {
    try {
      if (spend.calls === 0) await this.budget.release(reservation);
      else {
        await this.budget.settle(reservation, {
          model: this.llm.model,
          inputTokens: spend.inputTokens,
          outputTokens: spend.outputTokens,
          costMicroUsd: spend.costMicroUsd,
        });
      }
    } catch (error) {
      this.logger.warn(
        {
          organizationId: reservation.organizationId,
          reservationId: reservation.id,
          calls: spend.calls,
          costMicroUsd: spend.costMicroUsd.toString(),
          error: error instanceof Error ? error.name : 'unknown',
        },
        'cloud answer: budget not settled (the reservation expires on its own)',
      );
    }
  }
}
