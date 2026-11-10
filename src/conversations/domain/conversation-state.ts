import { DomainValidationError } from '../../shared/domain/errors.js';

/** States of a conversation, aligned with the copilot spec. Only `arquivado` belongs to the owner; the rest, to the executor. */
export const CONVERSATION_STATES = [
  'aviso',
  'trabalhando',
  'na_fila',
  'pede_sim',
  'esperando_pc',
  'concluido',
  'arquivado',
] as const;

export type ConversationState = (typeof CONVERSATION_STATES)[number];

export const ARCHIVED_STATE: ConversationState = 'arquivado';

export function assertConversationState(raw: string): ConversationState {
  if (!(CONVERSATION_STATES as readonly string[]).includes(raw)) {
    throw new DomainValidationError(
      'conversation-state-invalid',
      'The conversation state is invalid.',
    );
  }
  return raw as ConversationState;
}
