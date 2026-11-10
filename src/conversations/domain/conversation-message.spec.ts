import {
  DomainValidationError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';
import { newId } from '../../shared/domain/id.js';
import { ConversationMessage } from './conversation-message.js';
import { MAX_MESSAGE_BYTES } from './conversation-limits.js';

const now = new Date('2026-11-09T12:00:00.000Z');
const blob = (bytes: number, fill = 0xab) => {
  const b = Buffer.alloc(bytes, fill);
  b[0] = 0x01;
  return b.toString('base64url');
};
const USER = newId();
const HUB = newId();

const make = (
  over: Partial<Parameters<typeof ConversationMessage.create>[0]> = {},
) =>
  ConversationMessage.create({
    id: newId(),
    organizationId: 'org',
    conversationId: 'conv',
    author: { kind: 'user', userId: USER },
    keyVersion: 1,
    encryptedBody: blob(100),
    replacesMessageId: null,
    sentAt: now,
    now,
    ...over,
  });

describe('ConversationMessage', () => {
  it('a message from a person is born pending, with its encrypted size', () => {
    const m = make();
    expect(m.pending).toBe(true);
    expect(m.ackedAt).toBeNull();
    expect(m.bodyBytes).toBe(100);
    expect(m.authorUserId).toBe(USER);
    expect(m.authorHubId).toBeNull();
  });

  it('a message from the executor is born acknowledged', () => {
    const m = make({ author: { kind: 'hub', hubId: HUB } });
    expect(m.pending).toBe(false);
    expect(m.ackedAt).toBe(now);
    expect(m.authorHubId).toBe(HUB);
  });

  it('accepts a 64 KiB body and refuses one byte more (422 message-too-large)', () => {
    expect(make({ encryptedBody: blob(MAX_MESSAGE_BYTES) }).bodyBytes).toBe(
      MAX_MESSAGE_BYTES,
    );
    try {
      make({ encryptedBody: blob(MAX_MESSAGE_BYTES + 1) });
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(DomainValidationError);
      expect((e as DomainValidationError).code).toBe('message-too-large');
    }
  });

  it.each([
    ['a non-v7 id', { id: 'nope' }],
    ['key version 0', { keyVersion: 0 }],
    [
      'a body without the version byte',
      { encryptedBody: blob(60, 0x02).slice(2) },
    ],
    ['a body below the 41-byte overhead', { encryptedBody: blob(40) }],
  ])('rejects %s', (_, over) => {
    expect(() => make(over as never)).toThrow(DomainValidationError);
  });

  it('an edit references another message, never itself', () => {
    const id = newId();
    expect(() => make({ id, replacesMessageId: id })).toThrow(
      DomainValidationError,
    );
    const prev = newId();
    expect(make({ replacesMessageId: prev }).replacesMessageId).toBe(prev);
  });

  it('ack is idempotent: the first one wins', () => {
    const m = make();
    const later = new Date(now.getTime() + 5000);
    expect(m.ackedByHubId).toBeNull();
    expect(m.ack(later, 'hub-a')).toBe(true);
    expect(m.pending).toBe(false);
    expect(m.ackedAt).toBe(later);
    expect(m.ackedByHubId).toBe('hub-a');
    expect(m.ack(new Date(later.getTime() + 1), 'hub-b')).toBe(false);
    expect(m.ackedAt).toBe(later);
    expect(m.ackedByHubId).toBe('hub-a');
  });

  it('each one deletes only their own messages (403)', () => {
    const m = make();
    expect(() => m.assertAuthor({ kind: 'user', userId: USER })).not.toThrow();
    expect(() => m.assertAuthor({ kind: 'user', userId: newId() })).toThrow(
      PermissionDeniedError,
    );
    expect(() => m.assertAuthor({ kind: 'hub', hubId: HUB })).toThrow(
      PermissionDeniedError,
    );
    const fromHub = make({ author: { kind: 'hub', hubId: HUB } });
    expect(() =>
      fromHub.assertAuthor({ kind: 'hub', hubId: HUB }),
    ).not.toThrow();
  });

  it('a resend with the same id is the same submission only with the same content', () => {
    const m = make();
    const same = ConversationMessage.restore(m.snapshot(), m.id);
    expect(m.isSameSubmission(same)).toBe(true);
    const other = make({ id: m.id, encryptedBody: blob(101) });
    expect(m.isSameSubmission(other)).toBe(false);
  });

  it('the body is purged only after the tombstone; the size stays', () => {
    const m = make();
    expect(() => m.purgeBody()).toThrow();
    m.tombstone(now);
    m.purgeBody();
    expect(m.encryptedBody).toBeNull();
    expect(m.bodyBytes).toBe(100);
  });
});
