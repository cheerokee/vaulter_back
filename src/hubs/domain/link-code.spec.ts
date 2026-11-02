import { DomainValidationError } from '../../shared/domain/errors.js';
import { LinkCode, LINK_CODE_TTL_MS } from './link-code.js';

const now = new Date('2026-11-01T12:00:00Z');

describe('LinkCode', () => {
  it('issues a code valid for 10 minutes and consumes it once', () => {
    const c = LinkCode.issue({ hubId: 'h', codeHash: 'x', now });
    expect(c.expiresAt.getTime() - now.getTime()).toBe(LINK_CODE_TTL_MS);
    c.consume(now);
    expect(c.usedAt).toEqual(now);
    expect(() => c.consume(now)).toThrow(DomainValidationError);
    expect(() => c.consume(now)).toThrow(
      expect.objectContaining({ code: 'link-code-invalid' }),
    );
  });

  it('refuses an expired code', () => {
    const c = LinkCode.issue({ hubId: 'h', codeHash: 'x', now });
    expect(() => c.consume(new Date(now.getTime() + LINK_CODE_TTL_MS))).toThrow(
      expect.objectContaining({ code: 'link-code-invalid' }),
    );
    expect(c.usedAt).toBeNull();
  });
});
