import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  BASE64URL,
  MAX_KEY_VERSIONS,
  MAX_ROTATION_GRANTS,
  PUBLIC_KEY,
  WRAPPED_KEY,
} from './formats.js';

/** One key version sealed for one recipient. */
export class VersionGrantDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsString()
  @Matches(WRAPPED_KEY)
  wrappedKey!: string;
}

/** The new version sealed for one member. */
export class MemberGrantDto {
  @IsUUID()
  userId!: string;

  @IsString()
  @Matches(WRAPPED_KEY)
  wrappedKey!: string;
}

export class RotateSpaceKeyDto {
  /** current version + 1 (else 409 key-rotation-mismatch). */
  @IsInt()
  @Min(2)
  version!: number;

  @IsString()
  @Matches(PUBLIC_KEY)
  recoveryPublicKey!: string;

  @IsString()
  @Matches(WRAPPED_KEY)
  recoveryWrappedKey!: string;

  /** Exactly one copy per active member of the space (else 409 key-rotation-mismatch). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ROTATION_GRANTS)
  @ValidateNested({ each: true })
  @Type(() => MemberGrantDto)
  grants!: MemberGrantDto[];
}

export class RewrapRecoveryDto {
  @IsString()
  @Matches(PUBLIC_KEY)
  recoveryPublicKey!: string;

  /** The versions still sealed for a previous kit, or all of them, sealed for the current kit. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_KEY_VERSIONS)
  @ValidateNested({ each: true })
  @Type(() => VersionGrantDto)
  versions!: VersionGrantDto[];
}

export class RecoverOrphanSpaceDto {
  /** Every version, opened with the recovery kit and sealed for the admin. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_KEY_VERSIONS)
  @ValidateNested({ each: true })
  @Type(() => VersionGrantDto)
  grants!: VersionGrantDto[];

  @IsString()
  @Matches(BASE64URL)
  @MaxLength(256)
  currentAuthProof!: string;
}
