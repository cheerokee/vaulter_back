import { DomainValidationError } from '../../shared/domain/errors.js';
import { RESPONDER_HISTORY_MESSAGES } from './responder.js';

// Passo do cérebro do agente do PC (spec pc-agent §5.3): o agente no PC conduz o laço e chama o back a cada passo; o
// back roda prompt/RAG/modelo/orçamento sem estado. Aqui: as constantes da spec, o formato do pedido e da resposta (texto
// em claro, só em memória: nunca em log, banco, auditoria nem erro) e as regras puras de tamanho.

/** Model calls per answered message (12 steps plus room for retries); the back counts calls, never `stepIndex`. */
export const BRAIN_MAX_CALLS = 16;
/** Each tool result in `turns` (UTF-8 bytes; the agent cuts before, with a notice in the text). */
export const BRAIN_TOOL_RESULT_MAX_BYTES = 32 * 1024;
/** The whole JSON body of `POST /hub/conversations/:id/brain/step` (413 above, the body parser). */
export const BRAIN_BODY_MAX_BYTES = 256 * 1024;
/** History items the agent sends (the responder's window). */
export const BRAIN_HISTORY_MAX = RESPONDER_HISTORY_MESSAGES;
/** Previous turns of this answer: an assistant turn and a user turn (results) per model call. */
export const BRAIN_TURNS_MAX = 2 * BRAIN_MAX_CALLS;
/** Tool and tool-call ids/names in a content block (tool names are at most 200, like the catalog). */
export const BRAIN_BLOCK_ID_MAX = 200;

/** Same shape as the language model port's `LlmContentBlock` (the domain does not import the application). */
export type BrainContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      toolUseId: string;
      content: string;
      isError?: boolean;
    };

export type BrainHistoryItem = {
  id: string;
  author: 'person' | 'hub' | 'cloud';
  authorUserId?: string;
  text: string;
};

export type BrainTurn = {
  role: 'assistant' | 'user';
  content: BrainContentBlock[];
};

export type BrainStepRequest = {
  /** The person's message the agent acked and is answering. */
  messageId: string;
  /** 0, 1, 2... within this answer: only for the record (the limit counts calls). */
  stepIndex: number;
  history: BrainHistoryItem[];
  turns: BrainTurn[];
};

export type BrainToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  effect: 'allow' | 'confirm';
};

export type BrainStepResponse =
  | { kind: 'final'; text: string; policyVersion: number }
  | {
      kind: 'tools';
      text?: string;
      toolCalls: BrainToolCall[];
      policyVersion: number;
    }
  | { kind: 'refused'; reason: 'ai-budget-exceeded'; resetsAt: string };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;

const hasOnlyKeys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every((key) => allowed.includes(key));

const isId = (v: unknown) =>
  typeof v === 'string' && v.length > 0 && v.length <= BRAIN_BLOCK_ID_MAX;

/** Format of one content block of `turns` (exactly the fields of its type). */
export function isBrainContentBlock(v: unknown): v is BrainContentBlock {
  if (!isPlainObject(v)) return false;
  switch (v.type) {
    case 'text':
      return hasOnlyKeys(v, ['type', 'text']) && typeof v.text === 'string';
    case 'tool_use':
      return (
        hasOnlyKeys(v, ['type', 'id', 'name', 'input']) &&
        isId(v.id) &&
        isId(v.name) &&
        isPlainObject(v.input)
      );
    case 'tool_result':
      return (
        hasOnlyKeys(v, ['type', 'toolUseId', 'content', 'isError']) &&
        isId(v.toolUseId) &&
        typeof v.content === 'string' &&
        (v.isError === undefined || typeof v.isError === 'boolean')
      );
    default:
      return false;
  }
}

/**
 * Each tool result at most `BRAIN_TOOL_RESULT_MAX_BYTES` of UTF-8 (check 5 of spec §5.3), else 422 `validation-failed`
 * naming only the position (`turn`, `block`), never the content.
 */
export function assertToolResultSizes(turns: readonly BrainTurn[]): void {
  turns.forEach((turn, t) =>
    turn.content.forEach((block, b) => {
      if (
        block.type === 'tool_result' &&
        Buffer.byteLength(block.content, 'utf8') > BRAIN_TOOL_RESULT_MAX_BYTES
      ) {
        throw new DomainValidationError(
          'validation-failed',
          `A tool result is larger than ${BRAIN_TOOL_RESULT_MAX_BYTES} bytes: cut it before sending.`,
          { turn: t, block: b, maxBytes: BRAIN_TOOL_RESULT_MAX_BYTES },
        );
      }
    }),
  );
}

/** Check 2 of spec §5.3: the brain step only runs in a space in `active_cloud`. */
export const cloudNotActive = () =>
  new DomainValidationError(
    'cloud-not-active',
    'The space is not in the active cloud: the agent cannot use the cloud brain in it.',
  );

/** Check 2 of spec §5.3 (§5.8): the organization accepted no term version that covers the PC agent. */
export const cloudTermsAgentNotAccepted = () =>
  new DomainValidationError(
    'cloud-terms-agent-not-accepted',
    'The organization must accept an active-cloud term that covers the PC agent first.',
  );

/** Check 4 of spec §5.3: `BRAIN_MAX_CALLS` model calls already made for this message. */
export const brainStepLimit = () =>
  new DomainValidationError(
    'brain-step-limit',
    `The agent reached ${BRAIN_MAX_CALLS} model calls for this message.`,
    { maxCalls: BRAIN_MAX_CALLS },
  );
