import type { Logger } from '@nestjs/common';
import type { CloudConversationRead } from '../../../conversations/application/cloud-conversation-executor.js';
import { DomainError } from '../../../shared/domain/errors.js';
import { newId } from '../../../shared/domain/id.js';
import type { AiPricing } from '../../domain/ai-pricing.js';
import {
  confirmedProposal,
  type HistoryMessage,
} from '../../domain/document-gate.js';
import type {
  ChunkHit,
  CloudChunkRepository,
} from '../../domain/indexing.repositories.js';
import {
  decodeMessage,
  type DocumentProposal,
} from '../../domain/message-plaintext.js';
import {
  DOCUMENT_MAX_BYTES,
  DOCUMENT_TITLE_MAX_CHARS,
  RESPONDER_CONTEXT_CHUNKS,
  RESPONDER_HISTORY_MESSAGES,
  RESPONDER_MESSAGE_MAX_CHARS,
  utf8Bytes,
} from '../../domain/responder.js';
import {
  type CloudCipher,
  ConversationBlobOpenError,
} from '../ports/cloud-cipher.js';
import type { Embedder } from '../ports/embedder.js';
import type { LlmMessage, LlmToolCall } from '../ports/language-model.js';
import type { CloudDocumentWriter } from './cloud-document-writer.js';
import type { ResponderClock } from './responder-clock.js';

// Peças comuns ao responder da nuvem (`AnswerConversationJob`) e ao passo do cérebro do agente do PC
// (`BrainComposerImpl`): o gasto de uma resposta, a busca nos trechos do espaço, o histórico decifrado pelo servidor
// (das cópias da chave do assunto para o servidor), o histórico como turnos do modelo e as ferramentas de documento
// (`propose_document` / `record_document`, com a trava de confirmação `confirmedProposal`). Texto em claro só em memória:
// nada daqui vai a log.

/** The conversation keys opened from the server's copies, by version (the caller zeroes them). */
export type ServerKeys = Map<number, Uint8Array>;

/** Accumulates what the calls of one answer cost (the reservation is settled with the sum). */
export class Spend {
  inputTokens = 0;
  outputTokens = 0;
  costMicroUsd = 0n;
  calls = 0;
  add(cost: bigint, usage: { inputTokens: number; outputTokens: number }) {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.costMicroUsd += cost;
    this.calls += 1;
  }
}

/** What retrieval needs. */
export type RetrievalDeps = {
  embedder: Embedder;
  pricing: AiPricing;
  chunks: CloudChunkRepository;
};

/**
 * Embeds the question (cut to `RESPONDER_MESSAGE_MAX_CHARS`) as a query and adds the embedding's cost to `spend`. A
 * network call: never inside a unit of work. `null` for an empty question or no vector.
 */
export async function embedQuestion(
  deps: Pick<RetrievalDeps, 'embedder' | 'pricing'>,
  question: string,
  spend: Spend,
): Promise<{ vector: number[]; model: string } | null> {
  const query = question.slice(0, RESPONDER_MESSAGE_MAX_CHARS);
  if (!query.trim()) return null;
  const embedded = await deps.embedder.embed([query], 'query');
  spend.add(
    deps.pricing.costMicroUsd(
      { inputTokens: embedded.inputTokens, outputTokens: 0 },
      embedded.model,
    ),
    { inputTokens: 0, outputTokens: 0 },
  );
  const vector = embedded.vectors[0];
  return vector ? { vector, model: embedded.model } : null;
}

/** The `RESPONDER_CONTEXT_CHUNKS` chunks of THIS space closest to the question (only this space, only this model). */
export async function retrieve(
  deps: RetrievalDeps,
  p: { organizationId: string; spaceId: string },
  question: string,
  spend: Spend,
): Promise<ChunkHit[]> {
  const embedded = await embedQuestion(deps, question, spend);
  if (!embedded) return [];
  return deps.chunks.search(
    p.organizationId,
    p.spaceId,
    embedded.vector,
    embedded.model,
    RESPONDER_CONTEXT_CHUNKS,
  );
}

/** Cuts a text to at most `max` UTF-8 bytes (on a character boundary). */
export function cutUtf8(text: string, max: number): string {
  if (utf8Bytes(text) <= max) return text;
  let out = text;
  while (utf8Bytes(out) > max) out = out.slice(0, Math.floor(out.length * 0.9));
  return out;
}

/**
 * The history as model turns: people = `user` (labelled "Pessoa N" when there are several), the cloud and the Hub =
 * `assistant`; a proposal and a button decision are spelled out so the model knows the ids. Consecutive turns of the
 * same role are joined, and the conversation starts and ends with the person (the message being answered).
 */
export function toLlmMessages(
  history: readonly HistoryMessage[],
): LlmMessage[] {
  const people = new Map<string, number>();
  for (const m of history) {
    if (m.authorUserId && !people.has(m.authorUserId)) {
      people.set(m.authorUserId, people.size + 1);
    }
  }
  const turns: { role: 'user' | 'assistant'; text: string }[] = [];
  for (const m of history) {
    const role = m.author === 'person' ? 'user' : 'assistant';
    let text = m.content.text.slice(0, RESPONDER_MESSAGE_MAX_CHARS);
    if (role === 'user' && people.size > 1) {
      text = `[Pessoa ${people.get(m.authorUserId!)}] ${text}`;
    }
    const proposal = m.content.documentProposal;
    if (proposal) {
      text += `\n[Proposta de documento ${proposal.proposalId}: "${proposal.title}"${proposal.confidential ? ', confidencial' : ''}]`;
    }
    const decision = m.content.documentDecision;
    if (decision) {
      text += `\n[Botão: ${decision.decision === 'record' ? 'gravar' : 'não gravar'} a proposta ${decision.proposalId}]`;
    }
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.text += `\n\n${text}`;
    else turns.push({ role, text });
  }
  while (turns.length > 0 && turns[0]!.role !== 'user') turns.shift();
  return turns.map((t) => ({ role: t.role, content: t.text }));
}

/** The entries `decryptHistory` could not open (their text is a placeholder, never the person's). */
const unreadableEntries = new WeakSet<HistoryMessage>();

/** Whether `decryptHistory` could not open this entry (e.g. no retrieval on a placeholder question). */
export function isUnreadable(message: HistoryMessage): boolean {
  return unreadableEntries.has(message);
}

/**
 * The conversation's own history up to the message `targetId` (the most recent `RESPONDER_HISTORY_MESSAGES`), decrypted
 * by the server with `keys`. A message that does not open keeps its place as "[mensagem ilegível]" (the confirmation
 * gate's "immediately before" never skips over it; `isUnreadable` tells it apart); only the count is logged, under
 * `label`. A network-free call, but run it outside a unit of work anyway (the keys were opened from the KMS-backed
 * keyring).
 */
export async function decryptHistory(
  deps: { cipher: CloudCipher; logger: Logger; label: string },
  read: CloudConversationRead,
  targetId: string,
  keys: ServerKeys,
): Promise<HistoryMessage[]> {
  const upTo = read.messages.findIndex((m) => m.id === targetId);
  const slice = read.messages.slice(
    Math.max(0, upTo + 1 - RESPONDER_HISTORY_MESSAGES),
    upTo + 1,
  );
  const out: HistoryMessage[] = [];
  let unreadable = 0;
  for (const m of slice) {
    const author = m.authorCloud ? 'cloud' : m.authorHubId ? 'hub' : 'person';
    // An unreadable message keeps its place (the confirmation gate's "immediately before" never skips over it).
    const unreadableEntry = (): HistoryMessage => {
      const entry: HistoryMessage = {
        id: m.id,
        author,
        authorUserId: m.authorUserId,
        content: { text: '[mensagem ilegível]' },
      };
      unreadableEntries.add(entry);
      return entry;
    };
    const key = keys.get(m.keyVersion);
    if (!key) {
      unreadable += 1;
      out.push(unreadableEntry());
      continue;
    }
    let plaintext: Uint8Array | undefined;
    try {
      plaintext = await deps.cipher.openMessage(
        key,
        {
          spaceId: read.conversation.spaceId,
          conversationId: read.conversation.id,
          messageId: m.id,
          keyVersion: m.keyVersion,
        },
        Buffer.from(m.encryptedBody, 'base64url'),
      );
      out.push({
        id: m.id,
        author,
        authorUserId: m.authorUserId,
        content: decodeMessage(plaintext),
      });
    } catch (error) {
      if (!(error instanceof ConversationBlobOpenError)) throw error;
      unreadable += 1;
      out.push(unreadableEntry());
    } finally {
      plaintext?.fill(0);
    }
  }
  if (unreadable > 0) {
    deps.logger.warn(
      { conversationId: read.conversation.id, unreadable },
      deps.label,
    );
  }
  return out;
}

/** What a document tool call gave: the tool result for the model, and the proposal or the recorded document. */
export type DocumentToolOutcome = {
  result: Record<string, unknown>;
  isError: boolean;
  proposal?: DocumentProposal;
  recorded?: { fileId: string; title: string };
};

/**
 * Runs one call to `propose_document` / `record_document` (`RESPONDER_TOOLS`). `propose_document` only validates and
 * returns a proposal (nothing written). `record_document` records ONLY a proposal the gate confirms against `history`
 * (which MUST be the server-decrypted history, never text an agent sent): the proposal's content from that history, on
 * behalf of `target.authorUserId` (the recorded author of the message being answered: the person who confirmed; needs
 * `memory.write`). Refused, unconfirmed or failed = an error result for the model (`status: 'refused'`), nothing
 * written. `proposers` = which authors' proposals count (the cloud responder: only its own).
 */
export async function runDocumentTool(
  deps: { documents: CloudDocumentWriter; clock: ResponderClock },
  p: { organizationId: string; spaceId: string },
  target: { id: string; authorUserId: string | null },
  history: readonly HistoryMessage[],
  call: LlmToolCall,
  proposers?: readonly HistoryMessage['author'][],
): Promise<DocumentToolOutcome> {
  const fail = (reason: string, message: string) => ({
    result: { status: 'refused', reason, message },
    isError: true,
  });
  if (call.name === 'propose_document') {
    const { title, content, confidential } = call.input;
    if (
      typeof title !== 'string' ||
      !title.trim() ||
      title.length > DOCUMENT_TITLE_MAX_CHARS ||
      typeof content !== 'string' ||
      !content.trim() ||
      utf8Bytes(content) > DOCUMENT_MAX_BYTES
    ) {
      return fail(
        'invalid-document',
        `Título de 1 a ${DOCUMENT_TITLE_MAX_CHARS} caracteres e conteúdo de até ${DOCUMENT_MAX_BYTES} bytes.`,
      );
    }
    const proposal: DocumentProposal = {
      proposalId: newId(),
      title: title.trim(),
      content,
      confidential: confidential === true,
    };
    return {
      result: {
        status: 'proposed',
        proposalId: proposal.proposalId,
        message:
          'Nada foi gravado. Mostre o documento e pergunte se pode gravar (com o alerta de confidencialidade, se for o caso).',
      },
      isError: false,
      proposal,
    };
  }
  if (call.name === 'record_document') {
    const proposalId = call.input.proposalId;
    if (typeof proposalId !== 'string') {
      return fail('no-proposal', 'Informe o proposalId.');
    }
    const gate = confirmedProposal(history, target.id, proposalId, proposers);
    if ('refused' in gate) {
      return fail(
        gate.refused,
        gate.refused === 'declined'
          ? 'A pessoa recusou a gravação. Não grave.'
          : 'Não há proposta confirmada com esse id logo antes da mensagem da pessoa. Proponha com propose_document e pergunte antes de gravar.',
      );
    }
    try {
      await deps.documents.record({
        organizationId: p.organizationId,
        spaceId: p.spaceId,
        onBehalfOfUserId: target.authorUserId!,
        document: {
          fileId: gate.proposal.proposalId,
          title: gate.proposal.title,
          content: gate.proposal.content,
        },
        now: await deps.clock.now(),
      });
    } catch (error) {
      if (error instanceof DomainError) {
        return fail(error.code, recordFailureMessage(error.code));
      }
      throw error;
    }
    return {
      result: { status: 'recorded', fileId: gate.proposal.proposalId },
      isError: false,
      recorded: {
        fileId: gate.proposal.proposalId,
        title: gate.proposal.title,
      },
    };
  }
  return fail('unknown-tool', 'Ferramenta desconhecida.');
}

/** The model-facing text of a failed recording (by the error's code only). */
export function recordFailureMessage(code: string): string {
  switch (code) {
    case 'space-storage-full':
      return 'O espaço está cheio: não deu para gravar. Avise a pessoa.';
    case 'space-key-rotation-required':
      return 'O espaço precisa trocar a chave antes de receber conteúdo novo: não deu para gravar agora.';
    case 'space-not-found':
    case 'permission-denied':
    case 'forbidden':
      return 'A pessoa não pode gravar neste espaço (só Editores e Gestores). Não foi gravado.';
    default:
      return 'Não deu para gravar agora. Avise a pessoa.';
  }
}
