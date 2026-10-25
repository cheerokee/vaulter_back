import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import {
  SPACE_ROLE_KEYS,
  type SpaceRoleKey,
} from '../../../domain/space-membership.js';
import { VersionGrantDto } from './key.dto.js';
import { MAX_KEY_VERSIONS } from './formats.js';

export class AddSpaceMemberDto {
  @IsUUID()
  userId!: string;

  @IsIn(SPACE_ROLE_KEYS)
  roleKey!: SpaceRoleKey;

  /** The target's copy of EVERY key version of the space (else 409 key-versions-mismatch). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_KEY_VERSIONS)
  @ValidateNested({ each: true })
  @Type(() => VersionGrantDto)
  grants!: VersionGrantDto[];
}

export class ChangeSpaceMemberRoleDto {
  @IsIn(SPACE_ROLE_KEYS)
  roleKey!: SpaceRoleKey;
}

export class PromoteSpaceManagerDto {
  @IsUUID()
  userId!: string;
}
