import type { AiPricing } from '../../domain/ai-pricing.js';
import type { HistoryMessage } from '../../domain/document-gate.js';
import type {
  ChunkHit,
  CloudChunkRepository,
} from '../../domain/indexing.repositories.js';
import {
  RESPONDER_CONTEXT_CHUNKS,
  RESPONDER_MESSAGE_MAX_CHARS,
  utf8Bytes,
} from '../../domain/responder.js';
import type { Embedder } from '../ports/embedder.js';
import type { LlmMessage } from '../ports/language-model.js';

// Peças comuns ao responder da nuvem (`AnswerConversationJob`) e ao passo do cérebro do agente do PC
// (`BrainComposerImpl`): o gasto de uma resposta, a busca nos trechos do espaço e o histórico como turnos do modelo.
// Texto em claro só em memória: nada daqui vai a log.

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
