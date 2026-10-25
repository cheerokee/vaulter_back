import 'reflect-metadata';
import { plainToInstance, Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  Min,
  validateSync,
} from 'class-validator';

// 32 bytes em base64url sem padding = 43 caracteres, e o último só pode ter 4 bits úteis.
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
};

export class EnvironmentVariables {
  @IsString()
  @IsNotEmpty()
  DB_APP_USERNAME!: string;

  @IsString()
  @IsNotEmpty()
  DB_APP_PASSWORD!: string;

  @IsOptional()
  @IsString()
  DB_TEST_DATABASE?: string;

  @IsUrl({ require_tld: false })
  PROBLEM_TYPE_BASE_URL!: string;

  @IsString()
  @IsNotEmpty()
  API_DOCS_TITLE!: string;

  @Transform(toBoolean)
  @IsBoolean()
  API_DOCS_INTERNAL_ENABLED: boolean = false;

  @IsIn(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
  LOG_LEVEL: string = 'info';

  @Transform(toBoolean)
  @IsBoolean()
  LOG_PRETTY: boolean = false;

  @IsOptional()
  @IsString()
  SENTRY_DSN?: string;

  @IsString()
  SENTRY_ENVIRONMENT: string = 'development';

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  SENTRY_TRACES_SAMPLE_RATE: number = 0;

  @IsString()
  @IsNotEmpty()
  AUTH_JWT_ISSUER!: string;

  @IsString()
  @IsNotEmpty()
  AUTH_JWT_KEY_ID!: string;

  @Matches(BASE64URL_32_BYTES, {
    message:
      'AUTH_JWT_SIGNING_SEED must be 32 bytes encoded as base64url (43 chars, no padding)',
  })
  AUTH_JWT_SIGNING_SEED!: string;

  @Type(() => Number)
  @IsInt()
  @Min(60)
  AUTH_ACCESS_TOKEN_TTL_SECONDS: number = 900;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  AUTH_REFRESH_TOKEN_IDLE_DAYS: number = 30;

  @Matches(BASE64URL_32_BYTES, {
    message:
      'IDENTITY_DECOY_SALT_KEY must be 32 bytes encoded as base64url (43 chars, no padding)',
  })
  IDENTITY_DECOY_SALT_KEY!: string;
}

export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const env = plainToInstance(EnvironmentVariables, config);
  const errors = validateSync(env, { skipMissingProperties: false });
  if (errors.length > 0) {
    const details = errors
      .map(
        (e) =>
          `${e.property}: ${Object.values(e.constraints ?? {}).join('; ')}`,
      )
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return env;
}
