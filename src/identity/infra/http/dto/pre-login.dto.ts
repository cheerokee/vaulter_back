import { IsEmail, IsString, MaxLength } from 'class-validator';
import { Trim } from './trim.js';

export class PreLoginDto {
  @Trim()
  @IsString()
  @IsEmail()
  @MaxLength(255)
  email!: string;
}

export class PreLoginResponse {
  kdfSalt!: string;
  kdfParams!: { algorithm: string; opsLimit: number; memLimitBytes: number };
}
