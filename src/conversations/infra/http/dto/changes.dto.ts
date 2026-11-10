import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import type { ConversationChangesPage } from '../../../application/sync-conversations.use-case.js';
import {
  CONVERSATION_LONG_POLL_MAX_SECONDS,
  CONVERSATION_SYNC_MAX_LIMIT,
} from '../../../domain/conversation-limits.js';

/** Query of `GET /conversations/changes` (person). */
export class ConversationChangesQuery {
  /** The greatest `syncVersion` the client holds (`nextSince` of the previous page); 0 = full sync. */
  @IsOptional()
  @IsString()
  @Matches(/^(0|[1-9][0-9]{0,17})$/)
  since: string = '0';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CONVERSATION_SYNC_MAX_LIMIT)
  limit: number = CONVERSATION_SYNC_MAX_LIMIT;

  /** Only this conversation: backfill of a conversation that entered the scope (with `since=0`). */
  @IsOptional()
  @IsUUID()
  conversationId?: string;
}

/** Query of `GET /hub/conversations/changes` (executor): the same plus the long poll. */
export class HubConversationChangesQuery extends ConversationChangesQuery {
  /** Seconds to hold the request open while the page is empty (0 = answer at once). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(CONVERSATION_LONG_POLL_MAX_SECONDS)
  wait: number = 0;
}

// `sync_version` comes from a bigint sequence; as a JSON number it is exact up to 2^53 (far beyond any real count).
function toJsonNumber(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error('sync_version exceeds the JSON safe integer range');
  }
  return n;
}

export function conversationChangesResponse(page: ConversationChangesPage) {
  return {
    organizationIds: page.organizationIds,
    items: page.items.map((i) => ({
      type: i.type,
      syncVersion: toJsonNumber(i.syncVersion),
      deleted: i.deleted,
      data: i.data,
    })),
    nextSince: toJsonNumber(page.nextSince),
  };
}
