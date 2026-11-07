import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CursorPaginationQuery } from '../../../../shared/infra/http/cursor-pagination.query.js';

export class LookupUserQuery {
  @IsString()
  @MaxLength(320)
  email!: string;
}

/** `GET /platform/audit`: cursor page plus an optional support request filter. */
export class ListPlatformAuditQuery extends CursorPaginationQuery {
  @IsOptional()
  @IsUUID()
  supportRequestId?: string;
}
