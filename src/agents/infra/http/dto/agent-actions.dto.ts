import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  AGENT_ACTION_DECISIONS,
  AGENT_ACTION_EFFECTS,
  AGENT_ACTIONS_BATCH_MAX,
  type AgentActionDecision,
  type AgentActionItem,
} from '../../../domain/agent-action.js';
import type { RecordedAgentAction } from '../../../domain/agent-action.repository.js';
import type { AgentEffect } from '../../../domain/agent-policy.js';
import { CursorPaginationQuery } from '../../../../shared/infra/http/cursor-pagination.query.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const INT32_MAX = 2_147_483_647;

// One audited action. Exactly these fields: the global `ValidationPipe` (`forbidNonWhitelisted`) refuses any other, so
// no argument, result, path, URL or organization can come in. `startedAt` is ISO 8601; the organization and the space
// come from the conversation, read by the server.
export class AgentActionItemDto {
  @IsUUID()
  id!: string;

  @IsUUID()
  conversationId!: string;

  @IsUUID()
  messageId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  toolName!: string;

  @IsIn(AGENT_ACTION_EFFECTS)
  effect!: AgentEffect;

  @IsIn(AGENT_ACTION_DECISIONS)
  decision!: AgentActionDecision;

  @IsISO8601({ strict: true })
  startedAt!: string;

  @IsInt()
  @Min(0)
  @Max(DAY_MS)
  durationMs!: number;

  @IsInt()
  @Min(0)
  @Max(INT32_MAX)
  policyVersion!: number;
}

export class RecordAgentActionsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(AGENT_ACTIONS_BATCH_MAX)
  @ValidateNested({ each: true })
  @Type(() => AgentActionItemDto)
  items!: AgentActionItemDto[];
}

export const toAgentActionItem = (d: AgentActionItemDto): AgentActionItem => ({
  id: d.id.toLowerCase(),
  conversationId: d.conversationId.toLowerCase(),
  messageId: d.messageId.toLowerCase(),
  toolName: d.toolName,
  effect: d.effect,
  decision: d.decision,
  startedAt: new Date(d.startedAt),
  durationMs: d.durationMs,
  policyVersion: d.policyVersion,
});

export class OrganizationAgentActionsQuery extends CursorPaginationQuery {
  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsUUID()
  hubId?: string;
}

export const agentActionResponse = (a: RecordedAgentAction) => ({
  id: a.id,
  hubId: a.hubId,
  userId: a.ownerUserId,
  spaceId: a.spaceId,
  conversationId: a.conversationId,
  messageId: a.messageId,
  toolName: a.toolName,
  effect: a.effect,
  decision: a.decision,
  startedAt: a.startedAt.toISOString(),
  durationMs: a.durationMs,
  policyVersion: a.policyVersion,
  recordedAt: a.recordedAt.toISOString(),
});
