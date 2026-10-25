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

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export class CreateOrganizationDto {
  @IsString()
  @MaxLength(200)
  name!: string;
}

export class UpdateOrganizationDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
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
