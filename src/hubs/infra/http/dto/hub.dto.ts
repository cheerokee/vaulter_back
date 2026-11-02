import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Formats of the hubs API (shape only; the domain still checks the keys, the signature, the version byte of the
 * sealed copies and every rule). The module keeps its own copies of the patterns: it never imports another
 * module's infra.
 * - Ed25519 / X25519 public key: 32 bytes -> 43 base64url characters, no padding;
 * - Ed25519 detached signature: 64 bytes -> 86 characters;
 * - enrollment nonce: 16 bytes -> 22 characters; auth challenge: 32 bytes -> 43 characters;
 * - sealed copy v1 (`0x01 ‖ crypto_box_seal`): 81 bytes -> 108 characters;
 * - claim and link codes: 8 digits.
 */
export const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
export const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
export const NONCE = /^[A-Za-z0-9_-]{22}$/;
export const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
export const WRAPPED_KEY = /^[A-Za-z0-9_-]{108}$/;
export const CODE = /^[0-9]{8}$/;
/** Same bound as the domain (`assertHubName`: 1..255 after trim). */
export const HUB_NAME_MAX = 255;
/**
 * Versions sealed for the hub in one Room grant: EVERY version of the space goes in one request, like adding a
 * member in `spaces` (same bound, `MAX_KEY_VERSIONS = 500`, ~71 kB under the 100 kB JSON body limit).
 */
export const MAX_ROOM_VERSIONS = 500;

export class EnrollHubDto {
  @IsString()
  @Matches(PUBLIC_KEY)
  signingPublicKey!: string;

  @IsString()
  @Matches(PUBLIC_KEY)
  encryptionPublicKey!: string;

  /** 16 random bytes, single use per signing key. */
  @IsString()
  @Matches(NONCE)
  nonce!: string;

  /** ISO 8601 UTC, within ±5 min of the server clock (checked by the use case). */
  @IsString()
  @MaxLength(64)
  timestamp!: string;

  /** `hub-enroll-v1` over the keys, the nonce and the timestamp (docs/crypto/hub-identity.md). */
  @IsString()
  @Matches(SIGNATURE)
  signature!: string;
}

export class HubChallengeDto {
  @IsUUID()
  hubId!: string;
}

export class HubTokenDto {
  @IsUUID()
  hubId!: string;

  @IsString()
  @Matches(CHALLENGE)
  challenge!: string;

  /** `hub-auth-v1` over `{ hubId, challenge }`. */
  @IsString()
  @Matches(SIGNATURE)
  signature!: string;
}

export class ClaimHubDto {
  @IsString()
  @Matches(CODE)
  claimCode!: string;

  @IsString()
  @MaxLength(HUB_NAME_MAX)
  name!: string;
}

export class RenameHubDto {
  @IsString()
  @MaxLength(HUB_NAME_MAX)
  name!: string;
}

export class LinkOrganizationDto {
  @IsUUID()
  organizationId!: string;
}

export class LinkRequestDto {
  @IsString()
  @Matches(CODE)
  linkCode!: string;

  @IsUUID()
  organizationId!: string;
}

export class AddHubSpaceDto {
  @IsUUID()
  spaceId!: string;
}

/** One key version sealed for the hub's encryption public key. */
export class RoomGrantDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsString()
  @Matches(WRAPPED_KEY)
  wrappedKey!: string;
}

export class GrantRoomDto {
  /** Role of the Room in the space: `space_reader` (default) or `space_editor` (checked by the domain). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  roleKey?: string;

  /** The organization's current recovery kit (409 `recovery-key-changed` if it diverges). */
  @IsString()
  @Matches(PUBLIC_KEY)
  recoveryPublicKey!: string;

  /** Every key version of the space, sealed for the hub. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ROOM_VERSIONS)
  @ValidateNested({ each: true })
  @Type(() => RoomGrantDto)
  grants!: RoomGrantDto[];
}

export class AssignHubRoleDto {
  /** `hub_operator` or `hub_user` (422 `role-invalid` otherwise, from the domain). */
  @IsString()
  @MaxLength(64)
  roleKey!: string;
}
