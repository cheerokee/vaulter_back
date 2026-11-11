import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
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
  MAX_MESSAGE_BYTES,
} from '../../../domain/conversation-limits.js';
import {
  CONVERSATION_STATES,
  type ConversationState,
} from '../../../domain/conversation-state.js';
import { WRAPPED_CONVERSATION_KEY_PATTERN } from '../../../domain/wrapped-conversation-key.js';

const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** base64url text of the largest header (the domain checks the exact size: 422 `header-too-large`). */
const MAX_HEADER_CHARS = Math.ceil((MAX_HEADER_BYTES * 4) / 3);
/** base64url text of the largest message (the domain checks the exact size: 422 `message-too-large`). */
const MAX_MESSAGE_CHARS = Math.ceil((MAX_MESSAGE_BYTES * 4) / 3);
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

/** A new encrypted header (owner or executor), sealed with the CURRENT key version. */
export class ReplaceHeaderDto {
  @IsInt()
  @Min(1)
  keyVersion!: number;

  /** `0x01 ‖ nonce ‖ XChaCha20-Poly1305` with the conversation key `keyVersion` (docs/crypto/conversations.md), ≤ 16 KiB. */
  @IsString()
  @Matches(BASE64URL)
  @MaxLength(MAX_HEADER_CHARS + 4)
  encryptedHeader!: string;
}

/** The conversation a new one replaces (move to another space; only its owner). */
export class MovedFromDto {
  @IsUUID()
  spaceId!: string;

  @IsUUID()
  conversationId!: string;
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

  /** Move: the old conversation (another space) this one replaces; tombstone it afterwards with `POST .../move`. */
  @IsOptional()
  @ValidateNested()
  @Type(() => MovedFromDto)
  movedFrom?: MovedFromDto | null;

  /**
   * Version 1 sealed for the server key (`GET /cloud/server-key`): required exactly when the space is in the active
   * cloud (the cloud is born a reserve executor; 422 `cloud-reserve-copy-required` / `cloud-reserve-unavailable`).
   */
  @IsOptional()
  @IsString()
  @Matches(WRAPPED_CONVERSATION_KEY_PATTERN)
  serverWrappedKey?: string;
}

/** Switch the cloud reserve of a conversation on (every version sealed for the server key) or off (owner only). */
export class SetCloudReserveDto {
  @IsBoolean()
  enabled!: boolean;

  /** With `enabled: true`: every version 1..current sealed for the server key (409 `key-versions-mismatch`). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_VERSION_GRANTS)
  @ValidateNested({ each: true })
  @Type(() => VersionGrantDto)
  serverGrants?: VersionGrantDto[];
}

/** Completes a move: the conversation created in the destination with `movedFrom` = this one. */
export class MoveConversationDto {
  @IsUUID()
  toSpaceId!: string;

  @IsUUID()
  toConversationId!: string;
}

/** Empty the trash of the conversation (owner): the reauthentication proof of the current password. */
export class EmptyConversationTrashDto {
  @IsString()
  @Matches(BASE64URL)
  @MaxLength(256)
  currentAuthProof!: string;
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

  /**
   * Version 1 sealed for the server key (`GET /hub/cloud/server-key`): required exactly when the space is in the active
   * cloud (422 `cloud-reserve-copy-required` / `cloud-reserve-unavailable`).
   */
  @IsOptional()
  @IsString()
  @Matches(WRAPPED_CONVERSATION_KEY_PATTERN)
  serverWrappedKey?: string;
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

  /**
   * The new version sealed for the server key: required exactly while `cloudReserve` is on (else 409
   * `key-rotation-mismatch` with `missingServer` / `unexpectedServer`).
   */
  @IsOptional()
  @IsString()
  @Matches(WRAPPED_CONVERSATION_KEY_PATTERN)
  serverWrappedKey?: string;
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
    serverWrappedKey: dto.serverWrappedKey ?? null,
  };
}

export class SendMessageDto {
  /** UUID v7 generated on the device (part of the encryption AD): resending the same message is idempotent. */
  @IsUUID()
  id!: string;

  /** The current version of the conversation key (409 `conversation-key-version-stale` otherwise). */
  @IsInt()
  @Min(1)
  keyVersion!: number;

  /** `0x01 ‖ nonce ‖ XChaCha20-Poly1305` with the conversation key (docs/crypto/conversations.md), ≤ 64 KiB. */
  @IsString()
  @Matches(BASE64URL)
  @MaxLength(MAX_MESSAGE_CHARS + 4)
  encryptedBody!: string;

  /** Edit: a live message of mine in this conversation; it becomes a tombstone. */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  replacesMessageId?: string | null;
}

/** A person's message: may ask the cloud to answer it right away ("responder pela nuvem", spec active-cloud §4.3). */
export class SendUserMessageDto extends SendMessageDto {
  /** With the cloud reserve on, the cloud takes it at once instead of waiting for the Hub; ignored without it. */
  @IsOptional()
  @IsBoolean()
  cloudAnswer?: boolean;
}

/** "Responder pela nuvem" for the whole conversation (any participant; needs the cloud reserve). */
export class SetCloudAnswerDto {
  @IsBoolean()
  enabled!: boolean;
}

/** The use case input of a message (user and hub routes). */
export function messageInput(dto: SendMessageDto | SendUserMessageDto) {
  return {
    id: dto.id,
    keyVersion: dto.keyVersion,
    encryptedBody: dto.encryptedBody,
    replacesMessageId: dto.replacesMessageId ?? null,
    cloudAnswerRequested:
      'cloudAnswer' in dto ? (dto.cloudAnswer ?? false) : false,
  };
}

/** Upload intent of an encrypted attachment (the bytes go straight to S3 with the presigned PUT). */
export class RequestAttachmentDto {
  /** UUID v7 generated on the device (part of the encryption AD): repeating the same request is idempotent. */
  @IsUUID()
  id!: string;

  /** The current version of the conversation key (409 `conversation-key-version-stale` otherwise). */
  @IsInt()
  @Min(1)
  keyVersion!: number;

  /** Exact size of the encrypted blob; over 100 MiB: 422 `attachment-too-large`. */
  @IsInt()
  @Min(1)
  sizeBytes!: number;

  /** sha256 of the encrypted blob, 64 lowercase hex characters. */
  @Matches(/^[0-9a-f]{64}$/)
  sha256!: string;
}
