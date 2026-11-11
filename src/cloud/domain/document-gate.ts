import type { DocumentProposal, MessageContent } from './message-plaintext.js';

/** A message of the conversation's history, decrypted (legible: never logged). */
export type HistoryMessage = {
  id: string;
  author: 'person' | 'hub' | 'cloud';
  authorUserId: string | null;
  content: MessageContent;
};

export type GateRefusal =
  /** No proposal with that id right before the person's message (the model must propose and ask first). */
  | 'no-proposal'
  /** The person declined it with the app's button. */
  | 'declined';

/**
 * "Nunca grava em silêncio" (spec active-cloud §4.3), enforced by the server, not only by the prompt: the cloud records
 * a document ONLY when
 * 1. its own message IMMEDIATELY before the person's message being answered carried that exact proposal (title and
 *    content were shown to the person, and the confidentiality alert with the space audience when it applied), and
 * 2. the person's message is the answer to it: a structured decision (`documentDecision`, the app's buttons) must say
 *    `record` for that proposal; free text is judged by the model (it calls `record_document` only for a "yes").
 * What is recorded is the proposal's content from the history, never what the model sends again.
 */
export function confirmedProposal(
  history: readonly HistoryMessage[],
  answeringId: string,
  proposalId: string,
): { proposal: DocumentProposal } | { refused: GateRefusal } {
  const i = history.findIndex((m) => m.id === answeringId);
  const question = history[i];
  const previous = i > 0 ? history[i - 1] : undefined;
  if (
    !question ||
    question.author !== 'person' ||
    !previous ||
    previous.author !== 'cloud' ||
    previous.content.documentProposal?.proposalId !== proposalId
  ) {
    return { refused: 'no-proposal' };
  }
  const decision = question.content.documentDecision;
  if (
    decision &&
    (decision.proposalId !== proposalId || decision.decision !== 'record')
  ) {
    return { refused: 'declined' };
  }
  return { proposal: previous.content.documentProposal };
}
