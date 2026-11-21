import type { ConversationScope } from '../domain/conversation-actor.js';
import { brainStepNotOwned } from '../domain/conversation-errors.js';
import type { ConversationMessageRepository } from '../domain/conversation-message.repository.js';
import type { ConversationMessage } from '../domain/conversation-message.js';

/**
 * The agent's turn rule (spec pc-agent §5.3), shared by `AgentTurn` (brain step, lease renewal) and the agent's answer
 * (`SendMessageUseCase.byHub` of a `pc` hub): `messageId` is a live person's message of the conversation, acknowledged
 * by `hubId`, with its lease still running by the database clock, and without an answer of the agent (a hub message
 * with `answersMessageId` = it). Else 409 `brain-step-not-owned`. Inside the module only.
 */
export async function requireAgentTurnMessage(
  messages: ConversationMessageRepository,
  scope: ConversationScope,
  hubId: string,
  conversationId: string,
  messageId: string,
): Promise<ConversationMessage> {
  const message = await messages.findById(scope, messageId);
  if (
    !message ||
    message.conversationId !== conversationId ||
    !message.isAgentTurnOf(hubId, await messages.databaseNow()) ||
    (await messages.answeredBy(scope, conversationId, message.id))
  ) {
    throw brainStepNotOwned();
  }
  return message;
}
