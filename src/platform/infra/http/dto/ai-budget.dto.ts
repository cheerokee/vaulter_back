import {
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { SUPPORT_REQUEST_TEXT_MAX } from '../../../domain/support-request.js';
import { PlatformRoleChangeDto as ReauthDto } from './platform.dto.js';

/** `PUT /platform/organizations/:orgId/ai-budget`. */
export class SetAiBudgetDto extends ReauthDto {
  /** Monthly AI budget in micro-USD (US$ 1 = 1_000_000); 0 switches the AI off. */
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  budgetMicroUsd!: number;

  /** Why (e.g. plan change, invoice reference); kept in the platform trail. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(SUPPORT_REQUEST_TEXT_MAX)
  reason!: string;
}
