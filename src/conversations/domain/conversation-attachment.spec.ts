import {
  ConflictError,
  DomainValidationError,
} from '../../shared/domain/errors.js';
import { newId } from '../../shared/domain/id.js';
import { ConversationAttachment } from './conversation-attachment.js';
import { MAX_ATTACHMENT_BYTES } from './conversation-limits.js';
import {
  assertWrappedConversationKey,
  WRAPPED_CONVERSATION_KEY_PATTERN,
} from './wrapped-conversation-key.js';

const expires = new Date('2026-11-10T12:00:00.000Z');
const SHA = 'a'.repeat(64);

const make = (
  over: Partial<Parameters<typeof ConversationAttachment.create>[0]> = {},
) =>
  ConversationAttachment.create({
    id: newId(),
    organizationId: 'org',
    conversationId: 'conv',
    messageId: null,
    keyVersion: 1,
    sizeBytes: 1000,
    sha256: SHA,
    uploadExpiresAt: expires,
    ...over,
  });

describe('ConversationAttachment', () => {
  it('is born pending, without an S3 version', () => {
    const a = make();
    expect(a.status).toBe('pending');
    expect(a.s3VersionId).toBeNull();
    expect(a.s3WriteStartedAt).toBeNull();
  });

  it('accepts 100 MiB and refuses one byte more (422 attachment-too-large)', () => {
    expect(make({ sizeBytes: MAX_ATTACHMENT_BYTES }).sizeBytes).toBe(
      MAX_ATTACHMENT_BYTES,
    );
    try {
      make({ sizeBytes: MAX_ATTACHMENT_BYTES + 1 });
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(DomainValidationError);
      expect((e as DomainValidationError).code).toBe('attachment-too-large');
    }
  });

  it.each([
    ['size 0', { sizeBytes: 0 }],
    ['a fractional size', { sizeBytes: 1.5 }],
    ['an uppercase sha256', { sha256: 'A'.repeat(64) }],
    ['a short sha256', { sha256: 'a'.repeat(63) }],
    ['key version 0', { keyVersion: 0 }],
    ['a non-v7 id', { id: 'x' }],
  ])('rejects %s', (_, over) => {
    expect(() => make(over as never)).toThrow(DomainValidationError);
  });

  it('pending -> committed (with the S3 version) -> purged', () => {
    const a = make();
    expect(() => a.purge()).toThrow(ConflictError);
    a.commit('v1');
    expect(a.status).toBe('committed');
    expect(a.s3VersionId).toBe('v1');
    expect(() => a.commit('v2')).toThrow(ConflictError);
    a.purge();
    expect(a.status).toBe('purged');
    expect(a.s3VersionId).toBe('v1');
  });
});

describe('assertWrappedConversationKey', () => {
  const valid = (() => {
    const b = Buffer.alloc(81, 0x11);
    b[0] = 0x01;
    return b.toString('base64url');
  })();

  it('accepts the sealed copy format (0x01 ‖ crypto_box_seal, 108 chars)', () => {
    expect(valid).toHaveLength(108);
    expect(assertWrappedConversationKey(valid)).toBe(valid);
    expect(WRAPPED_CONVERSATION_KEY_PATTERN.source).toBe(
      '^[A-Za-z0-9_-]{108}$',
    );
  });

  it.each([
    ['107 chars', valid.slice(1)],
    ['wrong version byte', Buffer.alloc(81, 0x02).toString('base64url')],
    ['a non-base64url char', `${valid.slice(0, 107)}+`],
  ])('rejects %s', (_, key) => {
    expect(() => assertWrappedConversationKey(key)).toThrow(
      DomainValidationError,
    );
  });
});
