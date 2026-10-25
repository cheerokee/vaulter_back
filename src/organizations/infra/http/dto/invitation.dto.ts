import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { ORG_ROLE_KEYS, type OrgRoleKey } from '../../../domain/membership.js';

export class CreateInvitationDto {
  @IsIn(ORG_ROLE_KEYS)
  roleKey!: OrgRoleKey;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;
}

/** The secret travels in the body, never in the URL: request logs and Sentry record URLs. */
export class InvitationTokenDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  token!: string;
}
