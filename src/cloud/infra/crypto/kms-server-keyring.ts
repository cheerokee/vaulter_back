import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { getSodium } from '../../../shared/infra/crypto/sodium.js';
import { ServerKeyring } from '../../application/ports/server-keyring.js';
import {
  parseSealedCopy,
  SEALED_KEY_BYTES,
  sealedCopyInvalid,
} from '../../domain/sealed-copy.js';
import {
  ServerKeyTypeormStore,
  type StoredServerKey,
} from '../db/server-key.store.js';
import { KmsKeyEnvelope } from './kms-key-envelope.js';

/** KMS encryption context of the private key: label without the product name (it is bound to the ciphertext). */
export const SERVER_KEY_CONTEXT_PURPOSE = 'server-x25519-private-key-v1';

/**
 * How long an instance trusts its idea of which key is current before re-reading the row (one indexed read). Bounds
 * how long, after a rotation, an instance can still hand out the retired public key.
 */
export const SERVER_KEY_CURRENT_TTL_MS = 60_000;

interface OpenedKey {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

/**
 * `ServerKeyring` with the private key enveloped by KMS in `cloud_server_keys`.
 *
 * - **First use** (per database): generates the X25519 pair, has KMS encrypt the private key (context: purpose +
 *   public key) and stores both; concurrent instances serialize on an advisory lock, so one current key exists.
 * - **In memory:** every opened key is cached by public key in a private field (never serialized, never logged) and
 *   wiped on shutdown (`onApplicationShutdown`, after the job workers have drained). A ciphertext that KMS refuses
 *   (wrong key, context or a missing KMS key) is an error, never a reason to generate a new pair.
 * - **Which key is current** is re-read from the table every `SERVER_KEY_CURRENT_TTL_MS`; a copy that opens with no
 *   cached key reloads the rows (two reads of a tiny table; KMS only for a key never opened here) and tries the keys
 *   not tried yet.
 * - **Rotation** (procedure, no route yet), safe with several instances running: KMS key material rotates
 *   transparently (automatic rotation of the KMS key; old ciphertexts keep opening). A new server pair = set
 *   `retired_at` on the current row (owner login or a future admin route). The first instance whose TTL expires
 *   creates the new pair (advisory lock: only one); within `SERVER_KEY_CURRENT_TTL_MS` every instance hands out the
 *   new public key, and any instance opens a copy sealed to it at once (miss -> reload). Copies sealed to the retired
 *   key keep opening until the cloud re-seals them to the new key; then the retired row can be tombstoned.
 */
@Injectable()
export class KmsServerKeyring
  extends ServerKeyring
  implements OnApplicationShutdown
{
  /** Opened keys by public key (base64url): current and retired. */
  #opened = new Map<string, Promise<OpenedKey>>();
  #current: { publicKey: string; checkedAt: number } | undefined;
  #currentLoad: Promise<string> | undefined;

  constructor(
    private readonly store: ServerKeyTypeormStore,
    private readonly envelope: KmsKeyEnvelope,
  ) {
    super();
  }

  async publicKey(): Promise<string> {
    return this.currentPublicKey();
  }

  async openSealed(copy: string): Promise<Uint8Array> {
    const sealed = parseSealedCopy(copy);
    const sodium = await getSodium();
    const tryOpen = (key: OpenedKey): Uint8Array | null => {
      try {
        const opened = sodium.crypto_box_seal_open(
          sealed,
          key.publicKey,
          key.privateKey,
        );
        if (opened.length === SEALED_KEY_BYTES) return opened;
        sodium.memzero(opened);
        return null;
      } catch {
        return null;
      }
    };
    // The current key first (also refreshes it when the TTL expired), then every key already opened.
    const current = await this.currentPublicKey();
    const tried = new Set<string>();
    for (const pk of [current, ...this.#opened.keys()]) {
      if (tried.has(pk)) continue;
      tried.add(pk);
      // The current key must open (KMS down = error); a retired key that fails to open is skipped.
      const key =
        pk === current
          ? await this.openedKey(pk)
          : await this.openedKey(pk).catch(() => null);
      const opened = key && tryOpen(key);
      if (opened) return opened;
    }
    // A key another instance created or retired since: reload the rows and try only the keys not tried yet.
    for (const stored of await this.reloadRows()) {
      if (tried.has(stored.publicKey)) continue;
      tried.add(stored.publicKey);
      const key = await this.openStored(stored).catch(() => null);
      const opened = key && tryOpen(key);
      if (opened) return opened;
    }
    throw sealedCopyInvalid();
  }

  async onApplicationShutdown(): Promise<void> {
    const keys = await Promise.all(
      [...this.#opened.values()].map((p) => p.catch(() => undefined)),
    );
    this.#opened.clear();
    this.#current = undefined;
    const sodium = await getSodium();
    for (const key of keys) if (key) sodium.memzero(key.privateKey);
  }

  private currentPublicKey(): Promise<string> {
    const cached = this.#current;
    if (cached && Date.now() - cached.checkedAt < SERVER_KEY_CURRENT_TTL_MS) {
      return Promise.resolve(cached.publicKey);
    }
    if (!this.#currentLoad) {
      const load = this.store
        .currentOrCreate(() => this.generate())
        .then(async (stored) => {
          await this.openStored(stored);
          this.#current = {
            publicKey: stored.publicKey,
            checkedAt: Date.now(),
          };
          return stored.publicKey;
        });
      this.#currentLoad = load;
      // Settled either way: a failure (KMS or database down) is not cached, the next call tries again.
      void load
        .finally(() => {
          if (this.#currentLoad === load) this.#currentLoad = undefined;
        })
        .catch(() => undefined);
    }
    return this.#currentLoad;
  }

  /** Current (created if none) and retired rows, re-read now; the current one becomes the cached current. */
  private async reloadRows(): Promise<StoredServerKey[]> {
    const current = await this.store.currentOrCreate(() => this.generate());
    await this.openStored(current);
    this.#current = { publicKey: current.publicKey, checkedAt: Date.now() };
    return [current, ...(await this.store.retired())];
  }

  /** A key already opened (or being opened) by public key. */
  private openedKey(publicKey: string): Promise<OpenedKey> {
    const opened = this.#opened.get(publicKey);
    if (!opened) throw new Error('server key: not loaded'); // unreachable: current is opened before it is cached
    return opened;
  }

  private openStored(stored: StoredServerKey): Promise<OpenedKey> {
    let opened = this.#opened.get(stored.publicKey);
    if (!opened) {
      opened = this.open(stored);
      this.#opened.set(stored.publicKey, opened);
      const failed = opened;
      failed.catch(() => {
        if (this.#opened.get(stored.publicKey) === failed) {
          this.#opened.delete(stored.publicKey);
        }
      });
    }
    return opened;
  }

  private async generate(): Promise<StoredServerKey> {
    const sodium = await getSodium();
    const pair = sodium.crypto_box_keypair();
    try {
      const publicKey = Buffer.from(pair.publicKey).toString('base64url');
      const sealed = await this.envelope.seal(
        pair.privateKey,
        context(publicKey),
      );
      return {
        publicKey,
        encryptedPrivateKey: sealed.ciphertext,
        kmsKeyArn: sealed.keyArn,
      };
    } finally {
      sodium.memzero(pair.privateKey);
    }
  }

  private async open(stored: StoredServerKey): Promise<OpenedKey> {
    const sodium = await getSodium();
    const privateKey = await this.envelope.open(
      stored.encryptedPrivateKey,
      context(stored.publicKey),
    );
    const publicKey = new Uint8Array(
      Buffer.from(stored.publicKey, 'base64url'),
    );
    if (
      privateKey.length !== sodium.crypto_box_SECRETKEYBYTES ||
      publicKey.length !== sodium.crypto_box_PUBLICKEYBYTES ||
      !sodium.memcmp(sodium.crypto_scalarmult_base(privateKey), publicKey)
    ) {
      sodium.memzero(privateKey);
      throw new Error(
        'server key: the KMS-opened private key does not match its public key',
      );
    }
    return { publicKey, privateKey };
  }
}

function context(publicKey: string): Record<string, string> {
  return { purpose: SERVER_KEY_CONTEXT_PURPOSE, publicKey };
}
