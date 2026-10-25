// Self-contained on purpose: runs in a worker thread, from compiled .js in production and from .ts
// (Node strips types natively) under Vitest. Erasable syntax only; no imports besides libsodium.
import sodium from 'libsodium-wrappers-sumo';

// OWASP minimum for Argon2id: 2 iterations, 19 MiB. Kept in sync with the hasher by a spec.
export const OPS_LIMIT = 2;
export const MEM_LIMIT = 19_922_944;

export interface Argon2Job {
  op: 'hash' | 'verify';
  authProof: string;
  authHash?: string;
}

const ready = sodium.ready;

export default async function run({
  op,
  authProof,
  authHash,
}: Argon2Job): Promise<string | boolean> {
  await ready;
  if (op === 'hash') {
    return sodium.crypto_pwhash_str(authProof, OPS_LIMIT, MEM_LIMIT);
  }
  try {
    return sodium.crypto_pwhash_str_verify(authHash ?? '', authProof);
  } catch {
    return false;
  }
}
