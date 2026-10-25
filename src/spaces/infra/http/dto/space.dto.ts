import { IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';
import { CursorPaginationQuery } from '../../../../shared/infra/http/cursor-pagination.query.js';
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
