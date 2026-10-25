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
/** Versions sent at once (adding a member, recovering, rewrapping): every version of the space. */
export const MAX_KEY_VERSIONS = 100;
/**
 * Members in one rotation. 500 copies (~175 bytes each) stay under the 100 kB default JSON body limit;
 * a bigger space needs a bigger limit on this route first.
 */
export const MAX_ROTATION_GRANTS = 500;
