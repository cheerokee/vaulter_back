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

/**
 * States a conversation may be created in: a person opens a demand (`na_fila`) or a note (`aviso`); the Hub opens only
 * the copilot's notice (`aviso`); work states come later from the executor. Else 422 `conversation-state-invalid`.
 */
export const INITIAL_STATES = {
  user: ['na_fila', 'aviso'],
  hub: ['aviso'],
} as const satisfies Record<'user' | 'hub', readonly ConversationState[]>;

export function assertInitialState(
  by: 'user' | 'hub',
  raw: string,
): ConversationState {
  const state = assertConversationState(raw);
  if (!(INITIAL_STATES[by] as readonly string[]).includes(state)) {
    throw new DomainValidationError(
      'conversation-state-invalid',
      'A conversation cannot be created in this state.',
    );
  }
  return state;
}
