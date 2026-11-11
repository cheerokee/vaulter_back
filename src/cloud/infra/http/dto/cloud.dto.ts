import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import type {
  CloudTermsView,
  SpaceCloudStateView,
} from '../../../application/dto/cloud-views.js';

/** Sealed copy v1 (`0x01 ‖ crypto_box_seal`): 81 bytes, 108 base64url characters. */
const WRAPPED_KEY = /^[A-Za-z0-9_-]{108}$/;
/** Every version goes in one request, like adding a member to the space (same bound: ~71 kB of JSON). */
const MAX_KEY_VERSIONS = 500;

export class AcceptCloudTermsDto {
  /** The version shown (`GET .../cloud/terms` -> `current.version`). */
  @IsInt()
  @Min(1)
  version!: number;

  /** The SHA-256 (hex) of the text shown (`current.hash`). */
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  hash!: string;
}

export class ServerGrantDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsString()
  @Matches(WRAPPED_KEY)
  wrappedKey!: string;
}

export class ActivateSpaceCloudDto {
  /** Every key version of the space, sealed for the server key (`GET /cloud/server-key`). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_KEY_VERSIONS)
  @ValidateNested({ each: true })
  @Type(() => ServerGrantDto)
  serverGrants!: ServerGrantDto[];
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function cloudTermsResponse(v: CloudTermsView) {
  return {
    current: v.current
      ? {
          version: v.current.version,
          hash: v.current.hash,
          text: v.current.text,
          publishedAt: v.current.publishedAt.toISOString(),
        }
      : null,
    accepted: v.accepted ? acceptanceResponse(v.accepted) : null,
  };
}

export function acceptanceResponse(a: NonNullable<CloudTermsView['accepted']>) {
  return {
    version: a.version,
    hash: a.hash,
    acceptedAt: a.acceptedAt.toISOString(),
    acceptedByUserId: a.acceptedByUserId,
  };
}

export function spaceCloudResponse(v: SpaceCloudStateView) {
  return {
    spaceId: v.spaceId,
    state: v.state,
    termVersion: v.termVersion,
    authorizedAt: iso(v.authorizedAt),
    authorizedByUserId: v.authorizedByUserId,
    activatedAt: iso(v.activatedAt),
    activatedByUserId: v.activatedByUserId,
  };
}
