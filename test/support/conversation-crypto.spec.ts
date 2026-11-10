import { getSodium } from '../../src/shared/infra/crypto/sodium.js';
import { recoveryKitKeypair } from './client-crypto.js';
import {
  newConversationKey,
  openAttachment,
  openConversationKey,
  openHeader,
  openMessage,
  sealAttachment,
  sealConversationKey,
  sealHeader,
  sealMessage,
} from './conversation-crypto.js';

// Vector from docs/crypto/conversations.md.
const seq = (start: number, n: number) =>
  Uint8Array.from({ length: n }, (_, i) => start + i);
const KEY = seq(0x00, 32);
const NONCE = seq(0x20, 24);
const CTX = {
  spaceId: '40414243-4445-4647-4849-4a4b4c4d4e4f',
  conversationId: '50515253-5455-5657-5859-5a5b5c5d5e5f',
  recordId: '60616263-6465-6667-6869-6a6b6c6d6e6f',
  keyVersion: 1,
};
const HEADER_HEX =
  '01202122232425262728292a2b2c2d2e2f3031323334353637753c21a71483c8a9e77d1e1db831a358da9a0c3198';
const MESSAGE_HEX =
  '01202122232425262728292a2b2c2d2e2f3031323334353637753c21a714d532f25e7fe9f2540a388d3d8e22942e';
const ATTACHMENT_HEX =
  '01202122232425262728292a2b2c2d2e2f3031323334353637753c21a7143a4649e3daad5f7c5e708ad45a8f03d9';
const plain = new TextEncoder().encode('hello');

describe('conversation encryption format', () => {
  it('matches the documented test vectors', async () => {
    const sodium = await getSodium();
    expect(
      sodium.to_hex(
        await sealHeader(
          KEY,
          { ...CTX, recordId: CTX.conversationId },
          plain,
          NONCE,
        ),
      ),
    ).toBe(HEADER_HEX);
    expect(sodium.to_hex(await sealMessage(KEY, CTX, plain, NONCE))).toBe(
      MESSAGE_HEX,
    );
    expect(sodium.to_hex(await sealAttachment(KEY, CTX, plain, NONCE))).toBe(
      ATTACHMENT_HEX,
    );
  });

  it('opens what it sealed', async () => {
    const h = { ...CTX, recordId: CTX.conversationId };
    expect(await openHeader(KEY, h, await sealHeader(KEY, h, plain))).toEqual(
      plain,
    );
    expect(
      await openMessage(KEY, CTX, await sealMessage(KEY, CTX, plain)),
    ).toEqual(plain);
    expect(
      await openAttachment(KEY, CTX, await sealAttachment(KEY, CTX, plain)),
    ).toEqual(plain);
  });

  it.each([
    ['spaceId', { spaceId: '40414243-4445-4647-4849-4a4b4c4d4e50' }],
    [
      'conversationId',
      { conversationId: '50515253-5455-5657-5859-5a5b5c5d5e60' },
    ],
    ['recordId', { recordId: '60616263-6465-6667-6869-6a6b6c6d6e70' }],
    ['keyVersion', { keyVersion: 2 }],
  ])('refuses to open with another %s', async (_name, change) => {
    const blob = await sealMessage(KEY, CTX, plain, NONCE);
    await expect(
      openMessage(KEY, { ...CTX, ...change }, blob),
    ).rejects.toThrow();
  });

  it('refuses to open under another label', async () => {
    const blob = await sealMessage(KEY, CTX, plain, NONCE);
    await expect(openAttachment(KEY, CTX, blob)).rejects.toThrow();
    await expect(openHeader(KEY, CTX, blob)).rejects.toThrow();
  });

  it('refuses an unknown format version', async () => {
    const blob = await sealMessage(KEY, CTX, plain, NONCE);
    blob[0] = 2;
    await expect(openMessage(KEY, CTX, blob)).rejects.toThrow();
  });

  it('seals the conversation key as a 108-char copy and opens it', async () => {
    const pair = await recoveryKitKeypair();
    const key = await newConversationKey();
    expect(key).toHaveLength(32);
    const copy = await sealConversationKey(key, pair.publicKey);
    expect(copy).toMatch(/^[A-Za-z0-9_-]{108}$/);
    expect(
      await openConversationKey(copy, pair.publicKey, pair.privateKey),
    ).toEqual(key);
  });
});
