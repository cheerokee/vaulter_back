import { SPACE_MAX_MEMBERS } from '../../../domain/space-membership.js';

/**
 * Formats of the spaces API (shape only; the domain still checks the version byte and the rules).
 * - sealed copy v1: 81 bytes -> 108 base64url characters, no padding;
 * - X25519 public key (recovery kit): 32 bytes -> 43 characters.
 */
export const WRAPPED_KEY = /^[A-Za-z0-9_-]{108}$/;
export const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
export const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Same bound as the domain (Space: 1..255). */
export const SPACE_NAME_MAX = 255;
/**
 * Versions sent at once (adding a member, recovering, rewrapping): EVERY version of the space goes in one
 * request, so this grows with the versions (each exit from the space = one rotation = one version).
 * 500 x `{"version":NNNNNN,"wrappedKey":"<108>"}` (~142 bytes) ~= 71 kB, under the 100 kB default JSON body
 * limit. When spaces approach it: raise the JSON limit on these routes, or accept the versions in batches by
 * version range. The rotation's `version` itself is never capped.
 */
export const MAX_KEY_VERSIONS = 500;
/**
 * Member copies in one rotation = SPACE_MAX_MEMBERS (domain): 500 x `{"userId":"<36>","wrappedKey":"<108>"}`
 * (~175 bytes) ~= 88 kB, under the 100 kB default JSON body limit.
 */
export const MAX_ROTATION_GRANTS = SPACE_MAX_MEMBERS;
