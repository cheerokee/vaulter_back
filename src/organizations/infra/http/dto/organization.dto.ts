import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  HUB_LINK_POLICIES,
  type HubLinkPolicy,
} from '../../../domain/organization.js';

/** Same bound as the domain (Organization: 1..255). */
const ORGANIZATION_NAME_MAX = 255;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export class CreateOrganizationDto {
  @IsString()
  @MaxLength(ORGANIZATION_NAME_MAX)
  name!: string;
}

export class UpdateOrganizationDto {
  @IsOptional()
  @IsString()
  @MaxLength(ORGANIZATION_NAME_MAX)
  name?: string;

  @IsOptional()
  @IsIn(HUB_LINK_POLICIES)
  hubLinkPolicy?: HubLinkPolicy;
}

export class SetRecoveryKeyDto {
  @IsString()
  @Matches(BASE64URL)
  @MaxLength(256)
  recoveryPublicKey!: string;

  @IsString()
  @Matches(BASE64URL)
  @MaxLength(256)
  currentAuthProof!: string;
}
