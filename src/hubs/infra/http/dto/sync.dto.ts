import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { SYNC_MAX_LIMIT } from '../../../application/sync-hub.use-case.js';

/** Query of `GET /hub/sync`. */
export class HubSyncQuery {
  /** The greatest `syncVersion` the hub holds (`nextSince` of the previous page); 0 = full sync. */
  @IsOptional()
  @IsString()
  @Matches(/^(0|[1-9][0-9]{0,17})$/)
  since: string = '0';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SYNC_MAX_LIMIT)
  limit: number = SYNC_MAX_LIMIT;
}
