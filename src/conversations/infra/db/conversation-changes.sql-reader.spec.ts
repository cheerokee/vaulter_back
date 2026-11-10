import type { DataSource } from 'typeorm';
import { DomainValidationError } from '../../../shared/domain/errors.js';
import { ConversationChangesSqlReader } from './conversation-changes.sql-reader.js';

describe('ConversationChangesSqlReader', () => {
  const VALID = '019a0000-0000-7000-8000-000000000001';
  // Never touched: a malformed id must fail before any transaction is opened.
  const reader = new ConversationChangesSqlReader({} as DataSource);
  const query = (readerId: string, conversationId: string | null) => ({
    reader: { kind: 'user' as const, userId: readerId },
    organizationIds: vi.fn(() => Promise.resolve([])),
    since: 0n,
    limit: 10,
    conversationId,
  });

  it('rejects a malformed reader id instead of answering an empty feed (which would drop every organization)', async () => {
    await expect(reader.read(query('nope', null))).rejects.toMatchObject({
      constructor: DomainValidationError,
      code: 'sync-reader-invalid',
    });
  });

  it('rejects a malformed conversation filter', async () => {
    await expect(reader.read(query(VALID, 'nope'))).rejects.toMatchObject({
      constructor: DomainValidationError,
      code: 'conversation-id-invalid',
    });
  });
});
