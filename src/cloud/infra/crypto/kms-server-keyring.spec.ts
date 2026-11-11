import { inspect } from 'node:util';
import sodium from 'libsodium-wrappers-sumo';
import type { StoredServerKey } from '../db/server-key.store.js';
import { ServerKeyTypeormStore } from '../db/server-key.store.js';
import { KmsKeyEnvelope } from './kms-key-envelope.js';
import {
  KmsServerKeyring,
  SERVER_KEY_CONTEXT_PURPOSE,
  SERVER_KEY_CURRENT_TTL_MS,
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
    current: vi.fn(async () => current),
    retired: vi.fn(async () => retired),
    inTransaction: vi.fn(() => false),
    get stored() {
      return current;
    },
  } as unknown as ServerKeyTypeormStore & { stored: StoredServerKey | null };
}

/** The table shared by several instances: rows with `retired`, like cloud_server_keys. */
function sharedTable() {
  const rows: (StoredServerKey & { retired: boolean })[] = [];
  const store = () =>
    ({
      currentOrCreate: vi.fn(
        async (generate: () => Promise<StoredServerKey>) => {
          const live = rows.find((r) => !r.retired);
          if (live) return live;
          const created = { ...(await generate()), retired: false };
          rows.push(created);
          return created;
        },
      ),
      current: vi.fn(async () => rows.find((r) => !r.retired) ?? null),
      retired: vi.fn(async () => rows.filter((r) => r.retired).reverse()),
      inTransaction: vi.fn(() => false),
    }) as unknown as ServerKeyTypeormStore;
  return {
    store,
    retireCurrent: () => {
      for (const r of rows) r.retired = true;
    },
    rows,
  };
}

/** The store's methods as the mocks they are (no unbound-method reference to the class). */
const spies = (store: ServerKeyTypeormStore) =>
  store as unknown as Record<
    'currentOrCreate' | 'current' | 'retired' | 'inTransaction',
    ReturnType<typeof vi.fn>
  >;

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
    const row = {
      publicKey: pk,
      encryptedPrivateKey: sealed.ciphertext,
      kmsKeyArn: sealed.keyArn,
    };
    const store = {
      currentOrCreate: vi.fn(async () => row),
      current: vi.fn(async () => row),
      retired: vi.fn(async () => []),
      inTransaction: vi.fn(() => false),
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
    await keyring.onApplicationShutdown();
    expect(opened!.every((b) => b === 0)).toBe(true);
  });

  describe('rotation with several running instances', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('every instance moves to the new key within the TTL and opens copies sealed to it at once', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const table = sharedTable();
      const envelope = fakeEnvelope();
      const a = new KmsServerKeyring(table.store(), envelope);
      const b = new KmsServerKeyring(table.store(), envelope);
      const k1 = await a.publicKey();
      expect(await b.publicKey()).toBe(k1);
      const oldCopyKey = sodium.randombytes_buf(32);
      const oldCopy = seal(oldCopyKey, Buffer.from(k1, 'base64url'));

      table.retireCurrent();
      // Inside the TTL both still hand out K1 (bounded staleness).
      expect(await a.publicKey()).toBe(k1);
      vi.advanceTimersByTime(SERVER_KEY_CURRENT_TTL_MS);
      // B's TTL expired: it creates K2 (the only current row).
      const k2 = await b.publicKey();
      expect(k2).not.toBe(k1);
      expect(table.rows.filter((r) => !r.retired)).toHaveLength(1);

      // A has not refreshed yet, but a copy sealed to K2 opens on it right away (miss -> reload).
      const newKey = sodium.randombytes_buf(32);
      const newCopy = seal(newKey, Buffer.from(k2, 'base64url'));
      expect(Buffer.from(await a.openSealed(newCopy))).toEqual(
        Buffer.from(newKey),
      );
      // And A now hands out K2; copies sealed to the retired K1 keep opening everywhere.
      expect(await a.publicKey()).toBe(k2);
      for (const keyring of [a, b]) {
        expect(Buffer.from(await keyring.openSealed(oldCopy))).toEqual(
          Buffer.from(oldCopyKey),
        );
      }
      // Each private key was opened by KMS at most once per instance.
      expect(envelope.open).toHaveBeenCalledTimes(4);
    });

    it('a copy for an unknown key still fails with server-copy-invalid after the reload', async () => {
      const table = sharedTable();
      const keyring = new KmsServerKeyring(table.store(), fakeEnvelope());
      await keyring.publicKey();
      const other = sodium.crypto_box_keypair();
      await expect(
        keyring.openSealed(seal(sodium.randombytes_buf(32), other.publicKey)),
      ).rejects.toMatchObject({ code: 'server-copy-invalid' });
    });
  });
  describe('inside a unit of work (no phantom key, no KMS under the transaction)', () => {
    it('openSealed never creates a key: with no key at all it is the same 422', async () => {
      const store = memoryStore();
      const keyring = new KmsServerKeyring(store, fakeEnvelope());
      const other = sodium.crypto_box_keypair();
      await expect(
        keyring.openSealed(seal(sodium.randombytes_buf(32), other.publicKey)),
      ).rejects.toMatchObject({ code: 'server-copy-invalid' });
      expect(spies(store).currentOrCreate).not.toHaveBeenCalled();
      expect(store.stored).toBeNull();
    });

    it('a miss after a retirement reloads the rows but never creates the next key', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const table = sharedTable();
        const envelope = fakeEnvelope();
        const keyring = new KmsServerKeyring(table.store(), envelope);
        const k1 = await keyring.publicKey();
        table.retireCurrent();
        vi.advanceTimersByTime(SERVER_KEY_CURRENT_TTL_MS);
        const old = sodium.randombytes_buf(32);
        expect(
          Buffer.from(
            await keyring.openSealed(seal(old, Buffer.from(k1, 'base64url'))),
          ),
        ).toEqual(Buffer.from(old));
        const other = sodium.crypto_box_keypair();
        await expect(
          keyring.openSealed(seal(sodium.randombytes_buf(32), other.publicKey)),
        ).rejects.toMatchObject({ code: 'server-copy-invalid' });
        expect(table.rows).toHaveLength(1); // still only the retired K1
        expect(envelope.seal).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('publicKey() refuses to create a key inside a unit of work; prepare() refuses to run there', async () => {
      const store = memoryStore();
      spies(store).inTransaction.mockReturnValue(true);
      const keyring = new KmsServerKeyring(store, fakeEnvelope());
      await expect(keyring.publicKey()).rejects.toThrow(
        /never created inside a unit of work/,
      );
      await expect(keyring.prepare()).rejects.toThrow(
        /before the unit of work/,
      );
      expect(spies(store).currentOrCreate).not.toHaveBeenCalled();
    });

    it('after prepare(), opening inside a unit of work calls neither KMS nor the table', async () => {
      const table = sharedTable();
      const envelope = fakeEnvelope();
      const creator = new KmsServerKeyring(table.store(), envelope);
      const k1 = await creator.publicKey();
      table.retireCurrent();

      const store = table.store();
      const keyring = new KmsServerKeyring(store, envelope);
      await keyring.prepare(); // opens the retired K1 (no current row now)
      const opens = envelope.open.mock.calls.length;
      const reads = spies(store).current.mock.calls.length;
      spies(store).inTransaction.mockReturnValue(true);
      const key = sodium.randombytes_buf(32);
      expect(
        Buffer.from(
          await keyring.openSealed(seal(key, Buffer.from(k1, 'base64url'))),
        ),
      ).toEqual(Buffer.from(key));
      expect(envelope.open.mock.calls.length).toBe(opens);
      expect(spies(store).current.mock.calls.length).toBe(reads);
      expect(spies(store).currentOrCreate).not.toHaveBeenCalled();
    });
  });
});
