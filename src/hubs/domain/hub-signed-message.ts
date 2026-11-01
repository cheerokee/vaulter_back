/**
 * Hub signed messages (format v1, see docs/crypto/hub-identity.md).
 * Single source of truth for the canonical serialization: the server verifier and the test client both use it.
 */
export const HUB_LABELS = {
  enroll: 'hub-enroll-v1',
  status: 'hub-status-v1',
  auth: 'hub-auth-v1',
} as const;

export type HubLabel = (typeof HUB_LABELS)[keyof typeof HUB_LABELS];
export type HubSignedFields = Record<string, unknown>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalize(source[key]);
    }
    return sorted;
  }
  return value;
}

/** JSON with keys sorted recursively (by UTF-16 code units) and no whitespace. */
export function canonicalJson(fields: HubSignedFields): string {
  return JSON.stringify(canonicalize(fields));
}

/** Signed bytes: UTF-8(label) || 0x00 || UTF-8(canonical JSON). */
export function hubSignedBytes(
  label: string,
  fields: HubSignedFields,
): Uint8Array {
  return Buffer.concat([
    Buffer.from(label, 'utf8'),
    Buffer.from([0x00]),
    Buffer.from(canonicalJson(fields), 'utf8'),
  ]);
}
