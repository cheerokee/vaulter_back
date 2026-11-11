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
 * - **Creation** happens only in `publicKey()` called OUTSIDE any unit of work (`GET /cloud/server-key`): the X25519
 *   pair is generated, KMS encrypts the private key (context: purpose + public key) and the row is inserted in a short
 *   transaction of its own, committed before the key is cached or handed out (`ServerKeyTypeormStore.currentOrCreate`);
 *   concurrent instances serialize on an advisory lock, so one current key exists. `openSealed` and `prepare` NEVER
 *   create a key (a copy can only be sealed to a key some instance handed out, so it exists in the table): a rolled
 *   back request can never leave a "phantom" key in memory.
 * - **In memory:** every opened key is cached by public key in a private field (never serialized, never logged) and
 *   wiped on shutdown (`onApplicationShutdown`, after the job workers have drained). A ciphertext that KMS refuses
 *   (wrong key, context or a missing KMS key) is an error, never a reason to generate a new pair.
 * - **No KMS under a transaction (normal case):** `prepare()` runs before a use case opens its unit of work and opens,
 *   through KMS, every stored key not opened yet (read in autocommit, no connection held). Inside the unit of work
 *   `openSealed` then finds the keys in memory. Residual exception (documented): a key created or retired by another
 *   instance between `prepare()` and the transaction, or a `prepare` skipped, makes `openSealed` read the rows on the
 *   CALLER's connection (never a second one) and call KMS while the transaction is open, once per key and process.
 * - **Which key is current** is re-read from the table every `SERVER_KEY_CURRENT_TTL_MS`; a copy that opens with no
 *   cached key reloads the rows (two reads of a tiny table; KMS only for a key never opened here) and tries the keys
 *   not tried yet. Reads inside a unit of work are never shared with another request (a shared load would run on
 *   whichever request's connection started it).
 * - **Rotation** (procedure, no route yet), safe with several instances running: KMS key material rotates
 *   transparently (automatic rotation of the KMS key; old ciphertexts keep opening). A new server pair = set
 *   `retired_at` on the current row (owner login or a future admin route). The next `GET /cloud/server-key` on an
 *   instance whose TTL expired creates the new pair (advisory lock: only one); within `SERVER_KEY_CURRENT_TTL_MS`
 *   every instance hands out the new public key, and any instance opens a copy sealed to it at once (miss -> reload).
 *   Copies sealed to the retired key keep opening until the cloud re-seals them to the new key; then the retired row
 *   can be tombstoned.
 */
@Injectable()
export class KmsServerKeyring
  extends ServerKeyring
  implements OnApplicationShutdown
{
  /** Opened keys by public key (base64url): current and retired. */
  #opened = new Map<string, Promise<OpenedKey>>();
  /** The current public key as last read (`null`: no current row then). */
  #current: { publicKey: string | null; checkedAt: number } | undefined;
  /** Loads outside any unit of work, shared by concurrent callers (one per mode). */
  #loads = new Map<'create' | 'read', Promise<string | null>>();
  #prepared: { at: number; load: Promise<void> } | undefined;

  constructor(
    private readonly store: ServerKeyTypeormStore,
    private readonly envelope: KmsKeyEnvelope,
  ) {
    super();
  }

  async publicKey(): Promise<string> {
    const publicKey = await this.currentPublicKey(true);
    if (publicKey === null) {
      throw new Error('server key: no current key after creation'); // unreachable: create always yields one
    }
    return publicKey;
  }

  async prepare(): Promise<void> {
    if (this.store.inTransaction()) {
      throw new Error(
        'server key: prepare() runs before the unit of work, never inside it.',
      );
    }
    const prepared = this.#prepared;
    if (prepared && Date.now() - prepared.at < SERVER_KEY_CURRENT_TTL_MS) {
      return prepared.load;
    }
    const load = this.reloadRows().then(async (rows) => {
      // The current key was opened by reloadRows (a failure there is an error); a retired key that fails is skipped.
      for (const row of rows) await this.openStored(row).catch(() => null);
    });
    const entry = { at: Date.now(), load };
    this.#prepared = entry;
    // A failure is not cached: the next call tries again.
    load.catch(() => {
      if (this.#prepared === entry) this.#prepared = undefined;
    });
    return load;
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
    // The current key first (also refreshes it when the TTL expired, never creating one), then every key opened.
    const current = await this.currentPublicKey(false);
    const tried = new Set<string>();
    for (const pk of [
      ...(current !== null ? [current] : []),
      ...this.#opened.keys(),
    ]) {
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
    this.#prepared = undefined;
    const sodium = await getSodium();
    for (const key of keys) if (key) sodium.memzero(key.privateKey);
  }

  /**
   * The current public key (`null`: none exists and `create` is false). Created only with `create` and outside any
   * unit of work; inside one, a missing key is an error for `create` (programming error: `publicKey()` is called by
   * the route, outside transactions).
   */
  private currentPublicKey(create: boolean): Promise<string | null> {
    const cached = this.#current;
    if (
      cached &&
      Date.now() - cached.checkedAt < SERVER_KEY_CURRENT_TTL_MS &&
      (cached.publicKey !== null || !create)
    ) {
      return Promise.resolve(cached.publicKey);
    }
    if (this.store.inTransaction()) {
      // On the caller's own connection: never shared with another request, never creating.
      return this.store.current().then((stored) => {
        if (!stored && create) {
          throw new Error(
            'server key: none exists yet, and it is never created inside a unit of work.',
          );
        }
        return this.adoptCurrent(stored);
      });
    }
    const mode = create ? 'create' : 'read';
    let load = this.#loads.get(mode);
    if (!load) {
      const started = (
        create
          ? this.store.currentOrCreate(() => this.generate())
          : this.store.current()
      ).then((stored) => this.adoptCurrent(stored));
      load = started;
      this.#loads.set(mode, started);
      // Settled either way: a failure (KMS or database down) is not cached, the next call tries again.
      void started
        .finally(() => {
          if (this.#loads.get(mode) === started) this.#loads.delete(mode);
        })
        .catch(() => undefined);
    }
    return load;
  }

  /** Opens the current key (KMS failure = error) and remembers it as current; `null` = no current row. */
  private async adoptCurrent(
    stored: StoredServerKey | null,
  ): Promise<string | null> {
    if (stored) await this.openStored(stored);
    this.#current = {
      publicKey: stored?.publicKey ?? null,
      checkedAt: Date.now(),
    };
    return stored?.publicKey ?? null;
  }

  /** Current (if any) and retired rows, re-read now (never creating); the current one becomes the cached current. */
  private async reloadRows(): Promise<StoredServerKey[]> {
    const current = await this.store.current();
    await this.adoptCurrent(current);
    return [...(current ? [current] : []), ...(await this.store.retired())];
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
