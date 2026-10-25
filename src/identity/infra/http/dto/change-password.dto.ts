import { IsObject, IsString, Matches, MaxLength } from 'class-validator';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export class ChangePasswordDto {
  @IsString()
  @Matches(BASE64URL)
  @MaxLength(256)
  currentAuthProof!: string;

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
}
