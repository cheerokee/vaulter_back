import { Type } from 'class-transformer';
import {
  IsDefined,
  IsEmail,
  IsObject,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { DeviceDto } from './device.dto.js';
import { Trim } from './trim.js';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

// The recovery proof is checked for format only loosely here (base64url, bounded): a proof of the wrong size must
// get the same 401 `recovery-failed` as a wrong one, never a 422 that would tell them apart.

export class RecoveryLookupDto {
  @Trim()
  @IsString()
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @Matches(BASE64URL)
  @MaxLength(256)
  recoveryProof!: string;
}

export class RecoveryLookupResponse {
  /** The private key sealed with the recovery code (`docs/crypto/user-keys.md`); only the code opens it. */
  recoveryEncryptedPrivateKey!: string;
}

/** The new password material is the same as `PUT /me/password`, without `currentAuthProof`. */
export class RecoveryCompleteDto {
  @Trim()
  @IsString()
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @Matches(BASE64URL)
  @MaxLength(256)
  recoveryProof!: string;

  @IsString()
  @Matches(BASE64URL)
  @MaxLength(256)
  newAuthProof!: string;

  @IsString()
  @Matches(BASE64URL)
  @MaxLength(256)
  newKdfSalt!: string;

  @IsObject()
  newKdfParams!: Record<string, unknown>;

  @IsString()
  @Matches(BASE64URL)
  @MaxLength(256)
  newEncryptedPrivateKey!: string;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => DeviceDto)
  device!: DeviceDto;
}
