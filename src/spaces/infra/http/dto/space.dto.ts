import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { CursorPaginationQuery } from '../../../../shared/infra/http/cursor-pagination.query.js';
import {
  SPACE_STORAGE_QUOTA_MAX_BYTES,
  SPACE_STORAGE_QUOTA_MIN_BYTES,
} from '../../../domain/space.js';
import { PUBLIC_KEY, SPACE_NAME_MAX, WRAPPED_KEY } from './formats.js';

export class CreateSpaceDto {
  @IsString()
  @Length(1, SPACE_NAME_MAX)
  name!: string;

  /** The space key v1 sealed for the creator. */
  @IsString()
  @Matches(WRAPPED_KEY)
  wrappedKey!: string;

  /** The recovery kit the app sealed for: must be the organization's current one (else 409). */
  @IsString()
  @Matches(PUBLIC_KEY)
  recoveryPublicKey!: string;

  /** The space key v1 sealed for the recovery kit. */
  @IsString()
  @Matches(WRAPPED_KEY)
  recoveryWrappedKey!: string;

  /** Reserved size in bytes (1 GiB .. 5 TiB); 10 GiB when omitted. Must fit in the organization quota (else 422). */
  @IsOptional()
  @IsInt()
  @Min(SPACE_STORAGE_QUOTA_MIN_BYTES)
  @Max(SPACE_STORAGE_QUOTA_MAX_BYTES)
  storageQuotaBytes?: number;
}

export class ResizeSpaceStorageDto {
  /** New reserved size in bytes (1 GiB .. 5 TiB). */
  @IsInt()
  @Min(SPACE_STORAGE_QUOTA_MIN_BYTES)
  @Max(SPACE_STORAGE_QUOTA_MAX_BYTES)
  storageQuotaBytes!: number;
}

export class RenameSpaceDto {
  @IsString()
  @Length(1, SPACE_NAME_MAX)
  name!: string;
}

export class ListSpacesQuery extends CursorPaginationQuery {
  /** `true`: every space of the organization (needs org.spaces.create), only name, member count and date. */
  @IsOptional()
  @IsIn(['true', 'false'])
  all?: 'true' | 'false';
}
