import { createHash } from 'node:crypto';
import { parse, stringify } from 'uuid';

// O executor de reserva da nuvem (spec active-cloud §4.3; Task 7 do plano). Regras puras: quando a nuvem pega uma
// mensagem, em que ordem, e os ids determinísticos que tornam o trabalho idempotente.

/**
 * Hub first: the cloud takes a pending message only after this long without a Hub ack (plan, Global Constraints),
 * counted from the message's `sentAt` (database clock), unless "responder pela nuvem" asks for it at once.
 */
export const CLOUD_FALLBACK_AFTER_MS = 30_000;

/** Turns of the model per answer (each tool call is one more turn); the last one must be text. */
export const RESPONDER_MAX_TURNS = 4;
/** Output tokens per turn (Bedrock `maxTokens`). */
export const RESPONDER_MAX_OUTPUT_TOKENS = 1_500;
/** Messages of the conversation's own history in the prompt (the oldest go first). */
export const RESPONDER_HISTORY_MESSAGES = 40;
/** Space chunks (pgvector, cosine) in the prompt. */
export const RESPONDER_CONTEXT_CHUNKS = 8;
/** Messages one job run answers before handing over to a fresh job (keeps a run bounded). */
export const RESPONDER_MAX_MESSAGES_PER_RUN = 10;
/** Characters of one history message kept in the prompt (a longer one is cut). */
export const RESPONDER_MESSAGE_MAX_CHARS = 8_000;

/**
 * A document the cloud proposes (markdown), in UTF-8 bytes: the answer that proposes it carries it, and a message is at
 * most 64 KiB encrypted (`MAX_MESSAGE_BYTES`), with the answer text next to it.
 */
export const DOCUMENT_MAX_BYTES = 24 * 1024;
export const DOCUMENT_TITLE_MAX_CHARS = 200;
/** The answer's text, in UTF-8 bytes (a longer one is cut). */
export const ANSWER_TEXT_MAX_BYTES = 24 * 1024;

export const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

/**
 * A UUID v7 derived from another v7 and a label: same 48-bit timestamp, the rest from SHA-256(base ‖ label). The
 * cloud's answer to a message, its budget notice, a recorded document's file/object ids are derived this way, so a job
 * that runs twice (crash, retry, two instances) writes the SAME ids: the second write is a no-op or a 409 conflict,
 * never a second answer or a second document.
 */
export function derivedV7(base: string, label: string): string {
  const b = parse(base);
  const h = createHash('sha256')
    .update(base)
    .update('\0')
    .update(label)
    .digest();
  const out = new Uint8Array(16);
  out.set(b.subarray(0, 6), 0);
  out[6] = 0x70 | (h[0]! & 0x0f);
  out[7] = h[1]!;
  out[8] = 0x80 | (h[2]! & 0x3f);
  out.set(h.subarray(3, 10), 9);
  return stringify(out);
}

/** The cloud's answer to a person's message. */
export const answerIdFor = (messageId: string) =>
  derivedV7(messageId, 'cloud-answer');
/** The one "budget exhausted" notice for a backlog whose oldest pending message is `messageId`. */
export const budgetNoticeIdFor = (messageId: string) =>
  derivedV7(messageId, 'cloud-budget-notice');
/** The single backup object of a recorded document (its file id is the proposal id). */
export const documentObjectIdFor = (proposalId: string) =>
  derivedV7(proposalId, 'cloud-document-part-1');

/** What the planner needs of a message (from `CloudConversationExecutor.read`). */
export type PlannedMessage = {
  id: string;
  authorUserId: string | null;
  pending: boolean;
  ackedByCloud: boolean;
  cloudAnswerRequested: boolean;
  sentAt: Date;
};

export type ResponderStep =
  /** Answer it: `resume` = the cloud already acknowledged it (a run that crashed): no new ack race. */
  | { kind: 'answer'; message: PlannedMessage; resume: boolean }
  /** The next message is the Hub's for now: look again at `at`. */
  | { kind: 'wait'; at: Date }
  | { kind: 'idle' };

/**
 * The next step of the conversation's responder (ONE job per conversation, messages IN ORDER: the cloud never takes a
 * second message before answering the first). `messages` oldest first (the conversation's recent history).
 * 1. A person's message the cloud acknowledged and has not answered (no message with `answerIdFor(id)`): finish it
 *    first (a run that crashed between its ack and its answer).
 * 2. Else the oldest PENDING person message: due when "responder pela nuvem" (the conversation's, its own, or a later
 *    pending message's: answering in order means taking the ones before it too), when there is no executor Hub, or
 *    `CLOUD_FALLBACK_AFTER_MS` after its `sentAt` without a Hub ack; not due yet = wait until then.
 */
export function nextResponderStep(input: {
  messages: readonly PlannedMessage[];
  conversationCloudAnswer: boolean;
  hasExecutorHub: boolean;
  now: Date;
}): ResponderStep {
  const ids = new Set(input.messages.map((m) => m.id));
  const people = input.messages.filter((m) => m.authorUserId !== null);
  const unanswered = people.find(
    (m) => !m.pending && m.ackedByCloud && !ids.has(answerIdFor(m.id)),
  );
  if (unanswered) return { kind: 'answer', message: unanswered, resume: true };
  const pending = people.filter((m) => m.pending);
  const first = pending[0];
  if (!first) return { kind: 'idle' };
  const askedNow =
    input.conversationCloudAnswer ||
    !input.hasExecutorHub ||
    pending.some((m) => m.cloudAnswerRequested);
  const dueAt = new Date(first.sentAt.getTime() + CLOUD_FALLBACK_AFTER_MS);
  if (askedNow || dueAt.getTime() <= input.now.getTime()) {
    return { kind: 'answer', message: first, resume: false };
  }
  return { kind: 'wait', at: dueAt };
}
