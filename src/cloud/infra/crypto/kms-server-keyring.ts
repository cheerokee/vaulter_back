import { Injectable, type OnModuleDestroy } from '@nestjs/common';
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

interface OpenedKey {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

/**
 * `ServerKeyring` with the private key enveloped by KMS in `cloud_server_keys`.
 *
 * - **First use** (per database): generates the X25519 pair, has KMS encrypt the private key (context: purpose +
 *   public key) and stores both; concurrent instances serialize on an advisory lock, so one current key exists.
 * - **In memory:** the opened private key is cached for the process lifetime in a private field (never serialized,
 *   never logged) and wiped on shutdown. A ciphertext that KMS refuses (wrong key, context or a missing KMS key)
 *   is an error, never a reason to generate a new pair: copies sealed to the old one would be lost.
 * - **Rotation** (procedure, no route yet): KMS key material rotates transparently (automatic rotation of the KMS
 *   key; old ciphertexts keep opening). A new server pair = mark the current row `retired_at`, the next use creates a
 *   new one; copies sealed to the retired key keep opening (`openSealed` tries retired keys) until the cloud
 *   re-seals them to the new public key, then the retired row can be tombstoned.
 */
@Injectable()
export class KmsServerKeyring extends ServerKeyring implements OnModuleDestroy {
  #current: Promise<OpenedKey> | undefined;
  #retired: Promise<OpenedKey[]> | undefined;

  constructor(
    private readonly store: ServerKeyTypeormStore,
    private readonly envelope: KmsKeyEnvelope,
  ) {
    super();
  }

  async publicKey(): Promise<string> {
    const key = await this.current();
    return Buffer.from(key.publicKey).toString('base64url');
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
    const opened = tryOpen(await this.current());
    if (opened) return opened;
    for (const key of await this.retired()) {
      const old = tryOpen(key);
      if (old) return old;
    }
    throw sealedCopyInvalid();
  }

  async onModuleDestroy(): Promise<void> {
    const current = await this.#current?.catch(() => undefined);
    const retired = (await this.#retired?.catch(() => undefined)) ?? [];
    this.#current = undefined;
    this.#retired = undefined;
    const sodium = await getSodium();
    for (const key of [current, ...retired]) {
      if (key) sodium.memzero(key.privateKey);
    }
  }

  private current(): Promise<OpenedKey> {
    if (!this.#current) {
      this.#current = this.store
        .currentOrCreate(() => this.generate())
        .then((stored) => this.open(stored));
      // A failure (KMS or database down) is not cached: the next call tries again.
      this.#current.catch(() => {
        this.#current = undefined;
      });
    }
    return this.#current;
  }

  private retired(): Promise<OpenedKey[]> {
    if (!this.#retired) {
      this.#retired = this.store
        .retired()
        .then((rows) => Promise.all(rows.map((row) => this.open(row))));
      this.#retired.catch(() => {
        this.#retired = undefined;
      });
    }
    return this.#retired;
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
