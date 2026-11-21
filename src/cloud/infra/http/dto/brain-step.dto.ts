import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import {
  BRAIN_HISTORY_MAX,
  BRAIN_TURNS_MAX,
  isBrainContentBlock,
  type BrainContentBlock,
  type BrainStepRequest,
} from '../../../domain/brain-step.js';

// Pedido do passo do cérebro (spec pc-agent §5.3): texto em claro, só em memória. O formato é conferido aqui (422
// `validation-failed`); os tamanhos de cada resultado de ferramenta, no caso de uso (checagem 5). O corpo inteiro é
// limitado a 256 KiB pelo body parser desta rota (`JSON_BODY_LIMITS`), então nenhum texto tem teto próprio além dele.

const INT32_MAX = 2_147_483_647;

@ValidatorConstraint({ name: 'brainContentBlocks', async: false })
class BrainContentBlocksConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return Array.isArray(value) && value.every(isBrainContentBlock);
  }

  defaultMessage(): string {
    return 'content must be an array of text, tool_use or tool_result blocks';
  }
}

export class BrainHistoryItemDto {
  @IsUUID()
  id!: string;

  @IsIn(['person', 'hub', 'cloud'])
  author!: 'person' | 'hub' | 'cloud';

  @IsOptional()
  @IsUUID()
  authorUserId?: string;

  @IsString()
  text!: string;
}

export class BrainTurnDto {
  @IsIn(['assistant', 'user'])
  role!: 'assistant' | 'user';

  @IsArray()
  @Validate(BrainContentBlocksConstraint)
  content!: BrainContentBlock[];
}

export class BrainStepDto {
  @IsUUID()
  messageId!: string;

  @IsInt()
  @Min(0)
  @Max(INT32_MAX)
  stepIndex!: number;

  @IsArray()
  @ArrayMaxSize(BRAIN_HISTORY_MAX)
  @ValidateNested({ each: true })
  @Type(() => BrainHistoryItemDto)
  history!: BrainHistoryItemDto[];

  @IsArray()
  @ArrayMaxSize(BRAIN_TURNS_MAX)
  @ValidateNested({ each: true })
  @Type(() => BrainTurnDto)
  turns!: BrainTurnDto[];
}

/** Plain request for the use case (ids lowercased; optional fields only when present). */
export const toBrainStepRequest = (d: BrainStepDto): BrainStepRequest => ({
  messageId: d.messageId.toLowerCase(),
  stepIndex: d.stepIndex,
  history: d.history.map((item) => ({
    id: item.id.toLowerCase(),
    author: item.author,
    ...(item.authorUserId
      ? { authorUserId: item.authorUserId.toLowerCase() }
      : {}),
    text: item.text,
  })),
  turns: d.turns.map((turn) => ({ role: turn.role, content: turn.content })),
});
