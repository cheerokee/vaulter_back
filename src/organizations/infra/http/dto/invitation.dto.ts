import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import type { InvitationSpaceRoleKey } from '../../../../shared/application/invitation-hooks.js';
import { ORG_ROLE_KEYS, type OrgRoleKey } from '../../../domain/membership.js';

export const INVITATION_SPACE_ROLE_KEYS = [
  'space_reader',
  'space_editor',
  'space_manager',
] as const satisfies readonly InvitationSpaceRoleKey[];

export class InvitationSpaceDto {
  @IsUUID()
  spaceId!: string;

  @IsIn(INVITATION_SPACE_ROLE_KEYS)
  roleKey!: InvitationSpaceRoleKey;
}

export class CreateInvitationDto {
  @IsIn(ORG_ROLE_KEYS)
  roleKey!: OrgRoleKey;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  /** Spaces the invitee gets access to after accepting (needs the spaces module; no repeated spaceId). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => InvitationSpaceDto)
  spaces?: InvitationSpaceDto[];
}

/** The secret travels in the body, never in the URL: request logs and Sentry record URLs. */
export class InvitationTokenDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  token!: string;
}
