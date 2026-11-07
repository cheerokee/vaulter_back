import type { PipeTransform } from '@nestjs/common';
import { IsString, Matches, MaxLength } from 'class-validator';
import { RequestValidationError } from '../../../../shared/infra/http/request-validation.error.js';
import {
  isPlatformRoleKey,
  PLATFORM_ROLES,
  type PlatformRoleKey,
} from '../../../domain/platform-catalog.js';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Body of the role grant/revoke routes: the reauthentication proof. */
export class PlatformRoleChangeDto {
  @IsString()
  @Matches(BASE64URL)
  @MaxLength(256)
  currentAuthProof!: string;
}

/** `:roleKey` path parameter: one of the factory platform roles, else 422 validation-failed. */
export const platformRoleKeyPipe: PipeTransform<string, PlatformRoleKey> = {
  transform(value: string): PlatformRoleKey {
    if (!isPlatformRoleKey(value)) {
      throw new RequestValidationError([
        {
          field: 'roleKey',
          messages: [
            `roleKey must be one of: ${Object.keys(PLATFORM_ROLES).join(', ')}`,
          ],
        },
      ]);
    }
    return value;
  },
};
