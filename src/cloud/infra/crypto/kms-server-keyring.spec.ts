import { inspect } from 'node:util';
import sodium from 'libsodium-wrappers-sumo';
import type { StoredServerKey } from '../db/server-key.store.js';
import { ServerKeyTypeormStore } from '../db/server-key.store.js';
import { KmsKeyEnvelope } from './kms-key-envelope.js';
import {
  KmsServerKeyring,
  SERVER_KEY_CONTEXT_PURPOSE,
} from './kms-server-keyring.js';

// Fake KMS: "ciphertext" = base64(xor(plaintext, 0x5a) ‖ context json), so the test can see what was sealed.
function fakeEnvelope() {
  const seal = vi.fn(
    async (plaintext: Uint8Array, context: Record<string, string>) => ({
      ciphertext: Buffer.concat([
        Buffer.from(plaintext.map((b) => b ^ 0x5a)),
        Buffer.from(JSON.stringify(context)),
      ]).toString('base64'),
      keyArn: 'arn:aws:kms:us-east-1:000000000000:key/test',
    }),
  );
  const open = vi.fn(
    async (ciphertext: string, context: Record<string, string>) => {
      const raw = Buffer.from(ciphertext, 'base64');
      if (raw.subarray(32).toString() !== JSON.stringify(context)) {
        throw new Error('InvalidCiphertextException');
      }
      return new Uint8Array(raw.subarray(0, 32).map((b) => b ^ 0x5a));
    },
  );
  return { seal, open } as unknown as KmsKeyEnvelope & {
    seal: typeof seal;
    open: typeof open;
  };
}

function memoryStore(retired: StoredServerKey[] = []) {
  let current: StoredServerKey | null = null;
  return {
    currentOrCreate: vi.fn(async (generate: () => Promise<StoredServerKey>) => {
      current ??= await generate();
      return current;
    }),
    retired: vi.fn(async () => retired),
    get stored() {
      return current;
    },
  } as unknown as ServerKeyTypeormStore & { stored: StoredServerKey | null };
}

const seal = (key: Uint8Array, publicKey: Uint8Array) =>
  Buffer.concat([
    Buffer.from([0x01]),
    sodium.crypto_box_seal(key, publicKey),
  ]).toString('base64url');

describe('KmsServerKeyring', () => {
  beforeAll(async () => {
    await sodium.ready;
  });

  it('generates the pair once, enveloped by KMS with the public key in the context', async () => {
    const store = memoryStore();
    const envelope = fakeEnvelope();
    const keyring = new KmsServerKeyring(store, envelope);
    const pk = await keyring.publicKey();
    expect(pk).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await keyring.publicKey()).toBe(pk);
    expect(envelope.seal).toHaveBeenCalledTimes(1);
    expect(envelope.seal.mock.calls[0]![1]).toEqual({
      purpose: SERVER_KEY_CONTEXT_PURPOSE,
      publicKey: pk,
    });
    // Opened once and cached in memory.
    expect(envelope.open).toHaveBeenCalledTimes(1);
    expect(store.stored).toMatchObject({ publicKey: pk });
  });

  it('opens a copy sealed to its public key and returns the 32 bytes', async () => {
    const keyring = new KmsServerKeyring(memoryStore(), fakeEnvelope());
    const pk = Buffer.from(await keyring.publicKey(), 'base64url');
    const key = sodium.randombytes_buf(32);
    expect(Buffer.from(await keyring.openSealed(seal(key, pk)))).toEqual(
      Buffer.from(key),
    );
  });

  it('refuses a copy for another key and a malformed one with the same error', async () => {
    const keyring = new KmsServerKeyring(memoryStore(), fakeEnvelope());
    const other = sodium.crypto_box_keypair();
    await expect(
      keyring.openSealed(seal(sodium.randombytes_buf(32), other.publicKey)),
    ).rejects.toMatchObject({ code: 'server-copy-invalid' });
    await expect(keyring.openSealed('nope')).rejects.toMatchObject({
      code: 'server-copy-invalid',
    });
  });

  it('opens copies sealed to a retired key', async () => {
    const envelope = fakeEnvelope();
    const old = sodium.crypto_box_keypair();
    const oldPk = Buffer.from(old.publicKey).toString('base64url');
    const oldRow = {
      publicKey: oldPk,
      ...(await envelope
        .seal(old.privateKey, {
          purpose: SERVER_KEY_CONTEXT_PURPOSE,
          publicKey: oldPk,
        })
        .then((s) => ({
          encryptedPrivateKey: s.ciphertext,
          kmsKeyArn: s.keyArn,
        }))),
    };
    const keyring = new KmsServerKeyring(memoryStore([oldRow]), envelope);
    const key = sodium.randombytes_buf(32);
    expect(
      Buffer.from(await keyring.openSealed(seal(key, old.publicKey))),
    ).toEqual(Buffer.from(key));
    expect(await keyring.publicKey()).not.toBe(oldPk);
  });

  it('fails loudly (never regenerates) when KMS opens a key that does not match its public key', async () => {
    const envelope = fakeEnvelope();
    const pair = sodium.crypto_box_keypair();
    const another = sodium.crypto_box_keypair();
    const pk = Buffer.from(pair.publicKey).toString('base64url');
    const sealed = await envelope.seal(another.privateKey, {
      purpose: SERVER_KEY_CONTEXT_PURPOSE,
      publicKey: pk,
    });
    const store = {
      currentOrCreate: vi.fn(async () => ({
        publicKey: pk,
        encryptedPrivateKey: sealed.ciphertext,
        kmsKeyArn: sealed.keyArn,
      })),
      retired: vi.fn(async () => []),
    } as unknown as ServerKeyTypeormStore;
    const keyring = new KmsServerKeyring(store, envelope);
    await expect(keyring.publicKey()).rejects.toThrow(/does not match/);
    // Not cached: the next call tries again (and fails again), still without generating.
    await expect(keyring.publicKey()).rejects.toThrow(/does not match/);
    expect(envelope.seal).toHaveBeenCalledTimes(1); // only the test's own call
  });

  it('never exposes the private key through inspect or JSON', async () => {
    const envelope = fakeEnvelope();
    let privateKey: Uint8Array | undefined;
    envelope.open.mockImplementation(async (ciphertext: string) => {
      const raw = Buffer.from(ciphertext, 'base64');
      privateKey = new Uint8Array(raw.subarray(0, 32).map((b) => b ^ 0x5a));
      return new Uint8Array(privateKey);
    });
    const keyring = new KmsServerKeyring(memoryStore(), envelope);
    await keyring.publicKey();
    const hex = Buffer.from(privateKey!).toString('hex');
    const b64 = Buffer.from(privateKey!).toString('base64url');
    for (const dump of [
      inspect(keyring, { depth: 10 }),
      JSON.stringify(keyring),
    ]) {
      expect(dump).not.toContain(hex);
      expect(dump).not.toContain(b64);
      expect(dump).not.toMatch(/privateKey/);
    }
  });

  it('wipes the private key on shutdown', async () => {
    const envelope = fakeEnvelope();
    let opened: Uint8Array<ArrayBuffer> | undefined;
    envelope.open.mockImplementation(async (ciphertext: string) => {
      const raw = Buffer.from(ciphertext, 'base64');
      const key = new Uint8Array(32);
      key.set(raw.subarray(0, 32).map((b) => b ^ 0x5a));
      opened = key;
      return key;
    });
    const keyring = new KmsServerKeyring(memoryStore(), envelope);
    await keyring.publicKey();
    expect(opened!.some((b) => b !== 0)).toBe(true);
    await keyring.onModuleDestroy();
    expect(opened!.every((b) => b === 0)).toBe(true);
  });
});
