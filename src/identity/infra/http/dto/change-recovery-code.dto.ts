import { IsString, Matches, MaxLength } from 'class-validator';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export class ChangeRecoveryCodeDto {
  @IsString()
  @Matches(BASE64URL)
  @MaxLength(256)
  currentAuthProof!: string;

  @IsString()
  @Matches(BASE64URL)
  @MaxLength(256)
  newRecoveryProof!: string;

  @IsString()
  @Matches(BASE64URL)
  @MaxLength(256)
  newRecoveryEncryptedPrivateKey!: string;
}
