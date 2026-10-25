import { Type } from 'class-transformer';
import {
  IsEmail,
  IsObject,
  IsString,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { DeviceDto } from './device.dto.js';
import { Trim } from './trim.js';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export class RegisterDto {
  @IsString()
  @Length(1, 255)
  name!: string;

  @Trim()
  @IsString()
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @Matches(BASE64URL)
  @MaxLength(256)
  authProof!: string;

  @IsString()
  @Matches(BASE64URL)
  @MaxLength(256)
  kdfSalt!: string;

  @IsObject()
  kdfParams!: Record<string, unknown>;

  @IsString()
  @Matches(BASE64URL)
  @MaxLength(256)
  publicKey!: string;

  @IsString()
  @Matches(BASE64URL)
  @MaxLength(256)
  encryptedPrivateKey!: string;

  @ValidateNested()
  @Type(() => DeviceDto)
  device!: DeviceDto;
}
