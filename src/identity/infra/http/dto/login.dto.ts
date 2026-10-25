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

export class LoginDto {
  @Trim()
  @IsString()
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9_-]+$/)
  @MaxLength(256)
  authProof!: string;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => DeviceDto)
  device!: DeviceDto;
}
