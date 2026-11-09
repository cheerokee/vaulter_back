import {
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { SUPPORT_REQUEST_TEXT_MAX } from '../../../domain/support-request.js';
import { PlatformRoleChangeDto as ReauthDto } from './platform.dto.js';

/** `PUT /platform/organizations/:orgId/storage-quota`. */
export class SetStorageQuotaDto extends ReauthDto {
  /** New cloud quota in bytes (the column is a bigint read as a JS number: up to 2^53 - 1). */
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  quotaBytes!: number;

  /** Why (e.g. plan change, invoice reference); kept in the platform trail. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(SUPPORT_REQUEST_TEXT_MAX)
  reason!: string;
}
