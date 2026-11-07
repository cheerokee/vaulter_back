import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { CursorPaginationQuery } from '../../../../shared/infra/http/cursor-pagination.query.js';
import {
  SUPPORT_REQUEST_STATUSES,
  SUPPORT_REQUEST_TEXT_MAX,
  SUPPORT_REQUEST_TYPES,
  type PlatformSupportRequestStatus,
  type PlatformSupportRequestType,
} from '../../../domain/support-request.js';
// Same reauthentication body as the role routes (`currentAuthProof`).
import { PlatformRoleChangeDto as ReauthDto } from './platform.dto.js';

/**
 * `POST /platform/support-requests`. The target depends on the type (checked by the domain, 422
 * `support-request-target-invalid`): `hub_force_deregister` takes `hubId`; `org_appoint_admin` takes
 * `organizationId` and `userId`.
 */
export class CreateSupportRequestDto extends ReauthDto {
  @IsIn(SUPPORT_REQUEST_TYPES)
  type!: PlatformSupportRequestType;

  @IsOptional()
  @IsUUID()
  hubId?: string;

  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  /** Why the request is needed. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(SUPPORT_REQUEST_TEXT_MAX)
  reason!: string;

  /** What was checked and its references (e.g. invoice, document, external verification number). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(SUPPORT_REQUEST_TEXT_MAX)
  evidence!: string;
}

/** `POST /platform/support-requests/:id/approve`: the reauthentication proof. */
export class ApproveSupportRequestDto extends ReauthDto {}

/** `POST /platform/support-requests/:id/reject`: why it was refused, plus the reauthentication proof. */
export class RejectSupportRequestDto extends ReauthDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(SUPPORT_REQUEST_TEXT_MAX)
  note!: string;
}

/** `GET /platform/support-requests`: cursor page plus an optional status filter. */
export class ListSupportRequestsQuery extends CursorPaginationQuery {
  @IsOptional()
  @IsIn(SUPPORT_REQUEST_STATUSES)
  status?: PlatformSupportRequestStatus;
}
