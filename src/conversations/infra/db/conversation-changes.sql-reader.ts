import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { DataSource, type EntityManager } from 'typeorm';
import { DomainValidationError } from '../../../shared/domain/errors.js';
import {
  runInTransaction,
  runWithContext,
  type UnitOfWorkContext,
} from '../../../shared/infra/db/unit-of-work.js';
import {
  ConversationChangesReader,
  type ConversationChangesQuery,
  type ConversationChangesRead,
  type ConversationFeedReader,
  type ConversationItemType,
  type ConversationSyncBatch,
  type ConversationSyncItem,
} from '../../application/ports/conversation-changes-reader.js';

// Read model of the conversation feeds (person and executor), raw SQL over this module's own tables only.
//
// One snapshot: REPEATABLE READ, READ ONLY, the outermost transaction (SET TRANSACTION fails loudly inside another),
// short: it never waits for anything (the long poll waits OUTSIDE it, see SyncConversationsUseCase). The organization
// list is resolved inside it too (same snapshot).
//
// Two locks per organization, IN SEQUENCE (one connection: never Promise.all), each through `runWithContext`
// (`{ organizationId, userId }` or `{ organizationId, hubId }`, the other principal blank so a stray context never adds
// access):
// 1. RLS (migration CreateConversations): org_isolation AND participant/executor; the child tables also show the
//    reader's OWN participation and copies after leaving (their tombstones reach the feed);
// 2. the SQL repeats the scope: a conversation is in scope for a person in `participant_user_ids`, for a hub as
//    `executor_hub_id`; key copies are only the reader's own (`user_id` / `hub_id` = the reader), never anyone else's.
// The hub's organizations are only the approved, live links (`HubDirectory.approvedOrganizationIds`): the executor
// policy has no link condition, so this list is what keeps an unlinked organization out.
//
// COMMIT ORDER (migration ConversationFeedCommitOrder, `addCommitOrderedSyncVersion`): the versions of these tables are
// assigned AT COMMIT, in commit order, from one sequence under one advisory lock. A snapshot that sees version V sees
// every committed row with a version <= V, so `nextSince` never passes a version that can still commit; no horizon,
// nothing held back, no dependency on other transactions. Only `sync_pending = false` rows are served (every committed
// row is; the filter documents it).
type Row = Record<string, unknown> & {
  sv: string;
  deleted: boolean;
};
// $1 reader (user or hub id), $2 since, $3 limit, $4 organization, $5 conversation filter (or null),
// $6 the Hub a person's session is bound to (or null): only the conversations it executes.
type Params = [
  readerId: string,
  since: string,
  limit: number,
  organizationId: string,
  conversationId: string | null,
  sessionHubId: string | null,
];

const item = (
  type: ConversationItemType,
  row: Row,
  keys: Record<string, unknown>,
  fields: Record<string, unknown>,
): ConversationSyncItem => ({
  type,
  syncVersion: BigInt(row.sv),
  deleted: row.deleted,
  // Tombstones carry only the key fields: no encrypted payload is shipped again.
  data: row.deleted ? keys : { ...keys, ...fields },
});

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v);

// The conversation is in the reader's scope (beyond the RLS, which says the same). A person's session bound to a Hub
// ($6) only reaches what that Hub executes.
const IN_SCOPE = (reader: ConversationFeedReader, alias: string) =>
  reader.kind === 'user'
    ? `$1::uuid = ANY (${alias}.participant_user_ids)
       AND ($6::uuid IS NULL OR ${alias}.executor_hub_id = $6::uuid)`
    : `${alias}.executor_hub_id = $1::uuid AND $6::uuid IS NULL`;

// A LIVE conversation in scope. Children of a tombstoned conversation never reach the feeds (a moved conversation keeps
// its participants, copies and executor): its own tombstone is the whole signal, also on a `since=0` resync.
const CONVERSATION_OF = (reader: ConversationFeedReader, table: string) =>
  `EXISTS (SELECT 1 FROM conversations c
            WHERE c.id = ${table}.conversation_id AND c.organization_id = ${table}.organization_id
              AND c.deleted_at IS NULL AND ${IN_SCOPE(reader, 'c')})`;

// The reader still gets the conversation's tombstone itself (in scope, tombstoned): skip its children. Rows whose
// conversation the reader no longer sees (left, executor lost) still go, as the reader's own tombstones.
const NOT_UNDER_TOMBSTONE = (reader: ConversationFeedReader, table: string) =>
  `NOT EXISTS (SELECT 1 FROM conversations c
                WHERE c.id = ${table}.conversation_id AND c.organization_id = ${table}.organization_id
                  AND c.deleted_at IS NOT NULL AND ${IN_SCOPE(reader, 'c')})`;

const PAGE = (table: string) =>
  `${table}.organization_id = $4 AND ${table}.sync_version > $2::bigint AND NOT ${table}.sync_pending
     AND ($5::uuid IS NULL OR ${table}.${table === 'cv' ? 'id' : 'conversation_id'} = $5::uuid)`;

const VERSION = (table: string) => `${table}.sync_version::text AS sv`;

@Injectable()
export class ConversationChangesSqlReader extends ConversationChangesReader {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async read(
    query: ConversationChangesQuery,
  ): Promise<ConversationChangesRead> {
    const readerId =
      query.reader.kind === 'user' ? query.reader.userId : query.reader.hubId;
    // A malformed id is a bug or a forged request, never "an empty feed": an empty `organizationIds` would tell the
    // client to drop every conversation it holds.
    if (!validate(readerId)) {
      throw new DomainValidationError(
        'sync-reader-invalid',
        'The feed reader id is not a valid UUID.',
      );
    }
    if (query.conversationId !== null && !validate(query.conversationId)) {
      throw new DomainValidationError(
        'conversation-id-invalid',
        'The conversation id is not a valid UUID.',
      );
    }
    return runInTransaction(this.dataSource, async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
      );
      const organizationIds = [...(await query.organizationIds())].sort();
      const batches: ConversationSyncBatch[] = [];
      for (const organizationId of organizationIds) {
        const ctx: UnitOfWorkContext =
          query.reader.kind === 'user'
            ? { organizationId, userId: readerId, hubId: '' }
            : { organizationId, hubId: readerId, userId: '' };
        const read = await runWithContext(this.dataSource, ctx, (m) =>
          readOrganization(m, query.reader, [
            readerId,
            query.since.toString(),
            query.limit,
            organizationId,
            query.conversationId,
            query.reader.kind === 'user'
              ? (query.reader.sessionHubId ?? null)
              : null,
          ]),
        );
        batches.push(...read);
      }
      return { organizationIds, batches };
    });
  }
}

async function readOrganization(
  m: EntityManager,
  reader: ConversationFeedReader,
  params: Params,
): Promise<ConversationSyncBatch[]> {
  const batch = async (
    sql: string,
    map: (r: Row) => ConversationSyncItem,
  ): Promise<ConversationSyncBatch> => {
    const rows: Row[] = await m.query(sql, params);
    return { items: rows.map(map), truncated: rows.length >= params[2] };
  };
  const out: ConversationSyncBatch[] = [];

  out.push(
    await batch(
      `SELECT cv.id, cv.organization_id, cv.space_id, cv.created_by_user_id, cv.owner_user_id, cv.executor_hub_id,
              cv.state, cv.last_message_at, cv.current_key_version, cv.key_rotation_required, cv.encrypted_header,
              cv.header_key_version, cv.moved_from_conversation_id, cv.cloud_reserve, cv.cloud_reserve_declined,
              cv.created_at, cv.updated_at,
              cv.deleted_at IS NOT NULL AS deleted, ${VERSION('cv')}
         FROM conversations cv
        WHERE ${PAGE('cv')} AND ${IN_SCOPE(reader, 'cv')}
        ORDER BY cv.sync_version LIMIT $3`,
      (r) =>
        item(
          'conversation',
          r,
          { id: r.id },
          {
            organizationId: r.organization_id,
            spaceId: r.space_id,
            createdByUserId: r.created_by_user_id,
            ownerUserId: r.owner_user_id,
            executorHubId: r.executor_hub_id,
            state: r.state,
            lastMessageAt: iso(r.last_message_at),
            currentKeyVersion: r.current_key_version,
            keyRotationRequired: r.key_rotation_required,
            encryptedHeader: r.encrypted_header,
            headerKeyVersion: r.header_key_version,
            movedFromConversationId: r.moved_from_conversation_id,
            // With the reserve on, every rotation also seals for the server key (the server's copies never come here).
            cloudReserve: r.cloud_reserve,
            cloudReserveDeclined: r.cloud_reserve_declined,
            createdAt: iso(r.created_at),
            updatedAt: iso(r.updated_at),
          },
        ),
    ),
  );

  // Every participant of an in-scope conversation; for a person also the OWN rows (tombstones after leaving), except
  // through a session bound to a Hub (only what that Hub executes).
  const ownParticipation =
    reader.kind === 'user'
      ? `($6::uuid IS NULL AND p.user_id = $1::uuid AND ${NOT_UNDER_TOMBSTONE(reader, 'p')}) OR `
      : '';
  out.push(
    await batch(
      `SELECT p.id, p.conversation_id, p.user_id, p.joined_at,
              p.deleted_at IS NOT NULL AS deleted, ${VERSION('p')}
         FROM conversation_participants p
        WHERE ${PAGE('p')} AND (${ownParticipation}${CONVERSATION_OF(reader, 'p')})
        ORDER BY p.sync_version LIMIT $3`,
      (r) =>
        item(
          'conversation_participant',
          r,
          { id: r.id, conversationId: r.conversation_id, userId: r.user_id },
          { joinedAt: iso(r.joined_at) },
        ),
    ),
  );

  // Only the reader's OWN copies (every version, tombstones included): never another person's or hub's, never the
  // server's (`server_recipient`: neither column matches the reader).
  const ownCopy = reader.kind === 'user' ? 'g.user_id' : 'g.hub_id';
  out.push(
    await batch(
      `SELECT g.id, g.conversation_id, g.key_version, g.user_id, g.hub_id, g.wrapped_key,
              g.deleted_at IS NOT NULL AS deleted, ${VERSION('g')}
         FROM conversation_key_grants g
        WHERE ${PAGE('g')} AND ${ownCopy} = $1::uuid AND ${NOT_UNDER_TOMBSTONE(reader, 'g')}
          AND ($6::uuid IS NULL OR ${CONVERSATION_OF(reader, 'g')})
        ORDER BY g.sync_version LIMIT $3`,
      (r) =>
        item(
          'conversation_key_grant',
          r,
          {
            id: r.id,
            conversationId: r.conversation_id,
            keyVersion: r.key_version,
            userId: r.user_id,
            hubId: r.hub_id,
          },
          { wrappedKey: r.wrapped_key },
        ),
    ),
  );

  out.push(
    await batch(
      `SELECT msg.id, msg.conversation_id, msg.author_user_id, msg.author_hub_id, msg.author_cloud, msg.key_version,
              msg.encrypted_body, msg.body_bytes, msg.replaces_message_id, msg.pending, msg.acked_at, msg.sent_at,
              msg.deleted_at IS NOT NULL AS deleted, ${VERSION('msg')}
         FROM conversation_messages msg
        WHERE ${PAGE('msg')} AND ${CONVERSATION_OF(reader, 'msg')}
        ORDER BY msg.sync_version LIMIT $3`,
      (r) =>
        item(
          'conversation_message',
          r,
          { id: r.id, conversationId: r.conversation_id },
          {
            authorUserId: r.author_user_id,
            authorHubId: r.author_hub_id,
            authorCloud: r.author_cloud,
            keyVersion: r.key_version,
            encryptedBody: r.encrypted_body,
            bodyBytes: r.body_bytes,
            replacesMessageId: r.replaces_message_id,
            pending: r.pending,
            ackedAt: iso(r.acked_at),
            sentAt: iso(r.sent_at),
          },
        ),
    ),
  );

  // Metadata only (no S3 key, version or journal columns). `purged` (bytes gone) is a tombstone too.
  out.push(
    await batch(
      `SELECT a.id, a.conversation_id, a.message_id, a.key_version, a.size_bytes::text AS size_bytes, a.sha256,
              a.status, a.uploaded_by_user_id, a.uploaded_by_hub_id, a.created_at,
              (a.deleted_at IS NOT NULL OR a.status = 'purged') AS deleted, ${VERSION('a')}
         FROM conversation_attachments a
        WHERE ${PAGE('a')} AND ${CONVERSATION_OF(reader, 'a')}
        ORDER BY a.sync_version LIMIT $3`,
      (r) =>
        item(
          'conversation_attachment',
          r,
          { id: r.id, conversationId: r.conversation_id },
          {
            messageId: r.message_id,
            keyVersion: r.key_version,
            sizeBytes: Number(r.size_bytes),
            sha256: r.sha256,
            status: r.status,
            uploadedByUserId: r.uploaded_by_user_id,
            uploadedByHubId: r.uploaded_by_hub_id,
            createdAt: iso(r.created_at),
          },
        ),
    ),
  );
  return out;
}
