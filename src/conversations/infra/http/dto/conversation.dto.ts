import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  MAX_CONVERSATION_PARTICIPANTS,
  MAX_HEADER_BYTES,
} from '../../../domain/conversation-limits.js';
import {
  CONVERSATION_STATES,
  type ConversationState,
} from '../../../domain/conversation-state.js';
import { WRAPPED_CONVERSATION_KEY_PATTERN } from '../../../domain/wrapped-conversation-key.js';

const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** base64url text of the largest header (the domain checks the exact size: 422 `header-too-large`). */
const MAX_HEADER_CHARS = Math.ceil((MAX_HEADER_BYTES * 4) / 3);
/** A copy per version: a request sealing every version for a person stays far below the JSON body limit. */
const MAX_VERSION_GRANTS = 500;

/** One key version sealed for one recipient. */
export class VersionGrantDto {
  @IsInt()
  @Min(1)
  keyVersion!: number;

  @IsString()
  @Matches(WRAPPED_CONVERSATION_KEY_PATTERN)
  wrappedKey!: string;
}

export class UserGrantDto {
  @IsUUID()
  userId!: string;

  @IsString()
  @Matches(WRAPPED_CONVERSATION_KEY_PATTERN)
  wrappedKey!: string;
}

export class HubGrantDto {
  @IsUUID()
  hubId!: string;

  @IsString()
  @Matches(WRAPPED_CONVERSATION_KEY_PATTERN)
  wrappedKey!: string;
}

export class StateDto {
  @IsIn(CONVERSATION_STATES)
  state!: ConversationState;
}

class HeaderFields {
  /** UUID v7 generated on the device (part of the encryption AD); the domain checks the version. */
  @IsUUID()
  id!: string;

  @IsOptional()
  @IsIn(CONVERSATION_STATES)
  state?: ConversationState;

  /** `0x01 ‖ nonce ‖ XChaCha20-Poly1305` with the conversation key v1 (docs/crypto/conversations.md), ≤ 16 KiB. */
  @IsString()
  @Matches(BASE64URL)
  @MaxLength(MAX_HEADER_CHARS + 4)
  encryptedHeader!: string;
}

export class CreateConversationDto extends HeaderFields {
  /** Version 1 sealed for the creator. */
  @IsString()
  @Matches(WRAPPED_CONVERSATION_KEY_PATTERN)
  wrappedKey!: string;

  /** Optional executor: a hub of the creator with the space installed (422 `executor-invalid` otherwise). */
  @IsOptional()
  @ValidateNested()
  @Type(() => HubGrantDto)
  executor?: HubGrantDto | null;
}

export class HubCreateConversationDto extends HeaderFields {
  @IsUUID()
  spaceId!: string;

  /** The person the conversation is opened for (owner); must be in `grants`. */
  @IsUUID()
  ownerUserId!: string;

  /** Version 1 sealed for each participant: the owner and, when it is someone else, the hub owner. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_CONVERSATION_PARTICIPANTS)
  @ValidateNested({ each: true })
  @Type(() => UserGrantDto)
  grants!: UserGrantDto[];

  /** Version 1 sealed for the hub itself. */
  @IsString()
  @Matches(WRAPPED_CONVERSATION_KEY_PATTERN)
  hubWrappedKey!: string;
}

export class ShareTargetDto {
  @IsUUID()
  userId!: string;

  /** Every version 1..current (409 `key-versions-mismatch` otherwise). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_VERSION_GRANTS)
  @ValidateNested({ each: true })
  @Type(() => VersionGrantDto)
  grants!: VersionGrantDto[];
}

export class ShareConversationDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_CONVERSATION_PARTICIPANTS)
  @ValidateNested({ each: true })
  @Type(() => ShareTargetDto)
  participants!: ShareTargetDto[];
}

export class ChangeExecutorDto {
  /** The new executor hub, or null for none. */
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  hubId!: string | null;

  /** Every version 1..current sealed for the new hub (empty with `hubId: null`). */
  @IsArray()
  @ArrayMaxSize(MAX_VERSION_GRANTS)
  @ValidateNested({ each: true })
  @Type(() => VersionGrantDto)
  grants!: VersionGrantDto[];
}

export class RotateConversationKeyDto {
  /** current version + 1 (else 409 `conversation-key-version-stale`). */
  @IsInt()
  @Min(2)
  version!: number;

  /** Exactly one copy per live participant (else 409 `key-rotation-mismatch`). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_CONVERSATION_PARTICIPANTS)
  @ValidateNested({ each: true })
  @Type(() => UserGrantDto)
  grants!: UserGrantDto[];

  /** The executor's copy, empty without one (else 409 `key-rotation-mismatch`). */
  @IsArray()
  @ArrayMaxSize(1)
  @ValidateNested({ each: true })
  @Type(() => HubGrantDto)
  hubGrants!: HubGrantDto[];
}

/** The use case input of a rotation (user and hub routes). */
export function rotationInput(dto: RotateConversationKeyDto) {
  return {
    version: dto.version,
    grants: dto.grants.map((g) => ({
      userId: g.userId,
      wrappedKey: g.wrappedKey,
    })),
    hubGrants: dto.hubGrants.map((g) => ({
      hubId: g.hubId,
      wrappedKey: g.wrappedKey,
    })),
  };
}
