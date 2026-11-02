import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { DataSource, type EntityManager } from 'typeorm';
import {
  runInTransaction,
  runWithContext,
} from '../../../shared/infra/db/unit-of-work.js';
import {
  HubSyncReader,
  type SyncBatch,
  type SyncItem,
  type SyncItemType,
} from '../../application/ports/hub-sync-reader.js';

// Read model of the hub sync. DELIBERATE EXCEPTION to "a module never touches another module's repository or
// tables": the sync is a read-only projection (like a reporting query) over `users`, `user_organization`,
// `organizations`, `spaces`, `space_keys`, `space_key_grants`, `role_assignments` and `roles`, in raw SQL. It never
// writes and never imports another module's domain/infra. A schema change in identity/organizations/spaces must
// update these queries (the sync e2e covers every column read here).
//
// RLS, two locks:
// 1. hub context (`app.hub_id`): the hub row, its links (the hub policy only shows approved/revoked), its `hub_space`
//    rows (only of approved, live links), its hub-scope roles, and the list of approved organizations;
// 2. for each approved organization, IN SEQUENCE (one connection: never Promise.all), `{ organizationId, hubId }`
//    through `runWithContext`, which restores the previous context: `org_isolation` opens that organization's rows
//    and nothing else; the SQL adds the hub filters (live `hub_space` of THIS hub, people or THIS hub's grants/Room).
// `users` has no RLS: it is only reached through the organization's `user_organization` rows, and `auth_hash` is
// never selected.
//
// One snapshot: the transaction is REPEATABLE READ, READ ONLY, so every batch sees the same commits (a commit
// between two queries could otherwise put a later version on the page while an earlier one is missing, and
// `nextSince` would skip it). It must be the outermost transaction (SET TRANSACTION fails loudly inside another).
type Row = Record<string, unknown> & { sv: string; deleted: boolean };
type Params = [hubId: string, since: string, limit: number];
type OrgParams = [...Params, organizationId: string];

// One query = one batch; `truncated` when it hit the limit ($3), so rows above its last version may exist.
async function readBatch(
  m: EntityManager,
  sql: string,
  params: Params | OrgParams,
  map: (r: Row) => SyncItem,
): Promise<SyncBatch> {
  const rows: Row[] = await m.query(sql, params);
  return { items: rows.map(map), truncated: rows.length >= params[2] };
}

const item = (
  type: SyncItemType,
  row: Row,
  keys: Record<string, unknown>,
  fields: Record<string, unknown>,
): SyncItem => ({
  type,
  syncVersion: BigInt(row.sv),
  deleted: row.deleted,
  // Tombstones carry only the key fields: nothing personal or secret is shipped again.
  data: row.deleted ? keys : { ...keys, ...fields },
});

const ROLE_COLUMNS = `ra.id, r.key AS role_key, ra.scope_type, ra.organization_id, ra.space_id, ra.hub_id, ra.user_id,
  ra.room_hub_id, ra.approval_status, ra.deleted_at IS NOT NULL AS deleted, ra.sync_version::text AS sv`;

const roleItem = (r: Row): SyncItem =>
  item(
    'role_assignment',
    r,
    { id: r.id },
    {
      roleKey: r.role_key,
      scopeType: r.scope_type,
      organizationId: r.organization_id,
      spaceId: r.space_id,
      hubId: r.hub_id,
      userId: r.user_id,
      roomHubId: r.room_hub_id,
      approvalStatus: r.approval_status,
    },
  );

// Live hub_space of THIS hub for the row's space (the organization is pinned by the org context and the join).
const ON_HUB_SPACE = (alias: string) =>
  `JOIN hub_space hs ON hs.space_id = ${alias}.space_id AND hs.organization_id = ${alias}.organization_id
     AND hs.hub_id = $1 AND hs.deleted_at IS NULL`;

@Injectable()
export class HubSyncSqlReader extends HubSyncReader {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async read(
    hubId: string,
    since: bigint,
    limit: number,
  ): Promise<SyncBatch[]> {
    if (!validate(hubId)) return [];
    // $1 hub, $2 since, $3 limit (and $4 organization in the per-organization queries).
    const base: Params = [hubId, since.toString(), limit];
    const batch = (m: EntityManager, sql: string, map: (r: Row) => SyncItem) =>
      readBatch(m, sql, base, map);

    return runInTransaction(this.dataSource, async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
      );
      return runWithContext(this.dataSource, { hubId }, async (m) => {
        const batches: SyncBatch[] = [];
        batches.push(
          await batch(
            m,
            `SELECT id, name, owner_user_id, encryption_public_key, signing_public_key,
                    deleted_at IS NOT NULL AS deleted, sync_version::text AS sv
               FROM hubs WHERE id = $1 AND sync_version > $2::bigint
              ORDER BY sync_version LIMIT $3`,
            (r) =>
              item(
                'hub',
                r,
                { id: r.id },
                {
                  name: r.name,
                  ownerUserId: r.owner_user_id,
                  encryptionPublicKey: r.encryption_public_key,
                  signingPublicKey: r.signing_public_key,
                },
              ),
          ),
        );
        // Revoked = tombstone (the hub cascades locally); pending/rejected are invisible to the hub anyway.
        batches.push(
          await batch(
            m,
            `SELECT organization_id, status, (deleted_at IS NOT NULL OR status <> 'approved') AS deleted,
                    sync_version::text AS sv
               FROM hub_organization
              WHERE hub_id = $1 AND status IN ('approved', 'revoked') AND sync_version > $2::bigint
              ORDER BY sync_version LIMIT $3`,
            (r) =>
              item(
                'hub_organization',
                r,
                { hubId, organizationId: r.organization_id },
                { status: r.status },
              ),
          ),
        );
        batches.push(
          await batch(
            m,
            `SELECT hs.space_id, hs.organization_id, hs.added_by_user_id,
                    hs.deleted_at IS NOT NULL AS deleted, hs.sync_version::text AS sv
               FROM hub_space hs
              WHERE hs.hub_id = $1 AND hs.sync_version > $2::bigint
                AND EXISTS (SELECT 1 FROM hub_organization ho
                             WHERE ho.hub_id = hs.hub_id AND ho.organization_id = hs.organization_id
                               AND ho.status = 'approved' AND ho.deleted_at IS NULL)
              ORDER BY hs.sync_version LIMIT $3`,
            (r) =>
              item(
                'hub_space',
                r,
                { hubId, spaceId: r.space_id },
                {
                  organizationId: r.organization_id,
                  addedByUserId: r.added_by_user_id,
                },
              ),
          ),
        );
        batches.push(
          await batch(
            m,
            `SELECT ${ROLE_COLUMNS}
               FROM role_assignments ra JOIN roles r ON r.id = ra.role_id
              WHERE ra.scope_type = 'hub' AND ra.hub_id = $1 AND ra.sync_version > $2::bigint
              ORDER BY ra.sync_version LIMIT $3`,
            roleItem,
          ),
        );

        const orgs: { organization_id: string }[] = await m.query(
          `SELECT organization_id FROM hub_organization
            WHERE hub_id = $1 AND status = 'approved' AND deleted_at IS NULL
            ORDER BY organization_id`,
          [hubId],
        );
        for (const { organization_id: organizationId } of orgs) {
          batches.push(
            ...(await runWithContext(
              this.dataSource,
              { organizationId, hubId },
              (om) => readOrganization(om, [...base, organizationId]),
            )),
          );
        }
        return batches;
      });
    });
  }
}

async function readOrganization(
  m: EntityManager,
  params: OrgParams,
): Promise<SyncBatch[]> {
  const organizationId = params[3];
  const batch = (sqlM: EntityManager, sql: string, map: (r: Row) => SyncItem) =>
    readBatch(sqlM, sql, params, map);
  const out: SyncBatch[] = [];
  out.push(
    await batch(
      m,
      `SELECT id, name, is_personal, allow_room_spaces, deleted_at IS NOT NULL AS deleted,
                sync_version::text AS sv
           FROM organizations o
          WHERE o.id = $4 AND o.sync_version > $2::bigint
            AND EXISTS (SELECT 1 FROM hub_organization ho
                         WHERE ho.hub_id = $1 AND ho.organization_id = o.id
                           AND ho.status = 'approved' AND ho.deleted_at IS NULL)
          ORDER BY sync_version LIMIT $3`,
      (r) =>
        item(
          'organization',
          r,
          { id: r.id },
          {
            name: r.name,
            isPersonal: r.is_personal,
            allowRoomSpaces: r.allow_room_spaces,
          },
        ),
    ),
  );
  // Member = (organization, user). Its version is the greatest of the membership row, the user row (key material:
  // a password change re-wraps the private key and must reach the hub) and every role row it embeds (organization
  // roles here and this hub's role), tombstones included, so any of those changes re-sends the member.
  out.push(
    await batch(
      m,
      `SELECT u.id AS user_id, u.name, u.email, u.public_key, u.encrypted_private_key, u.kdf_salt, u.kdf_params,
                (uo.deleted_at IS NOT NULL OR u.deleted_at IS NOT NULL) AS deleted,
                COALESCE((SELECT array_agg(r.key::text ORDER BY r.key)
                            FROM role_assignments ra JOIN roles r ON r.id = ra.role_id
                           WHERE ra.scope_type = 'organization' AND ra.organization_id = uo.organization_id
                             AND ra.user_id = uo.user_id AND ra.deleted_at IS NULL), '{}') AS org_roles,
                (SELECT r.key FROM role_assignments ra JOIN roles r ON r.id = ra.role_id
                  WHERE ra.scope_type = 'hub' AND ra.hub_id = $1 AND ra.user_id = uo.user_id
                    AND ra.deleted_at IS NULL
                  LIMIT 1) AS hub_role,
                v.sv::text AS sv
           FROM user_organization uo
           JOIN users u ON u.id = uo.user_id
           CROSS JOIN LATERAL (
             SELECT GREATEST(uo.sync_version, u.sync_version, COALESCE((
               SELECT max(ra.sync_version) FROM role_assignments ra
                WHERE ra.user_id = uo.user_id
                  AND ((ra.scope_type = 'organization' AND ra.organization_id = uo.organization_id)
                    OR (ra.scope_type = 'hub' AND ra.hub_id = $1))), 0)) AS sv
           ) v
          WHERE uo.organization_id = $4 AND v.sv > $2::bigint
          ORDER BY v.sv LIMIT $3`,
      (r) =>
        item(
          'member',
          r,
          { organizationId: organizationId, userId: r.user_id },
          {
            name: r.name,
            email: r.email,
            publicKey: r.public_key,
            encryptedPrivateKey: r.encrypted_private_key,
            kdfSalt: r.kdf_salt,
            kdfParams: r.kdf_params,
            roles: {
              organization: r.org_roles,
              // Spec §6: a member of a linked organization without an explicit row counts as hub_user.
              hub: r.hub_role ?? 'hub_user',
            },
          },
        ),
    ),
  );
  out.push(
    await batch(
      m,
      `SELECT ${ROLE_COLUMNS}
           FROM role_assignments ra JOIN roles r ON r.id = ra.role_id
          WHERE ra.organization_id = $4 AND ra.sync_version > $2::bigint
            AND (ra.user_id IS NOT NULL OR ra.room_hub_id = $1)
            AND (ra.scope_type = 'organization'
              OR (ra.scope_type = 'space' AND EXISTS (
                    SELECT 1 FROM hub_space hs
                     WHERE hs.hub_id = $1 AND hs.space_id = ra.space_id
                       AND hs.organization_id = ra.organization_id AND hs.deleted_at IS NULL)))
          ORDER BY ra.sync_version LIMIT $3`,
      roleItem,
    ),
  );
  out.push(
    await batch(
      m,
      `SELECT s.id, s.name, s.cloud_mode, s.allow_online_llm, s.current_key_version, s.key_rotation_required,
                s.deleted_at IS NOT NULL AS deleted, s.sync_version::text AS sv
           FROM spaces s
           JOIN hub_space hs ON hs.space_id = s.id AND hs.organization_id = s.organization_id
            AND hs.hub_id = $1 AND hs.deleted_at IS NULL
          WHERE s.organization_id = $4 AND s.sync_version > $2::bigint
          ORDER BY s.sync_version LIMIT $3`,
      (r) =>
        item(
          'space',
          r,
          { id: r.id },
          {
            organizationId: organizationId,
            name: r.name,
            cloudMode: r.cloud_mode,
            allowOnlineLlm: r.allow_online_llm,
            currentKeyVersion: r.current_key_version,
            keyRotationRequired: r.key_rotation_required,
          },
        ),
    ),
  );
  // The kit copy (recovery_wrapped_key) is the organization's recovery path, not the hub's: never selected.
  out.push(
    await batch(
      m,
      `SELECT k.id, k.space_id, k.version, k.deleted_at IS NOT NULL AS deleted, k.sync_version::text AS sv
           FROM space_keys k ${ON_HUB_SPACE('k')}
          WHERE k.organization_id = $4 AND k.sync_version > $2::bigint
          ORDER BY k.sync_version LIMIT $3`,
      (r) =>
        item(
          'space_key',
          r,
          { id: r.id },
          {
            organizationId: organizationId,
            spaceId: r.space_id,
            version: r.version,
          },
        ),
    ),
  );
  // Copies for people, and for THIS hub only (another hub's copy, or an app installation's, never leaves).
  out.push(
    await batch(
      m,
      `SELECT g.id, k.space_id, g.space_key_id, k.version, g.user_id, g.hub_id, g.wrapped_key,
                g.deleted_at IS NOT NULL AS deleted, g.sync_version::text AS sv
           FROM space_key_grants g
           JOIN space_keys k ON k.id = g.space_key_id AND k.organization_id = g.organization_id
           ${ON_HUB_SPACE('k')}
          WHERE g.organization_id = $4 AND g.sync_version > $2::bigint
            AND (g.user_id IS NOT NULL OR g.hub_id = $1)
          ORDER BY g.sync_version LIMIT $3`,
      (r) =>
        item(
          'space_key_grant',
          r,
          { id: r.id },
          {
            organizationId: organizationId,
            spaceId: r.space_id,
            spaceKeyId: r.space_key_id,
            version: r.version,
            userId: r.user_id,
            hubId: r.hub_id,
            wrappedKey: r.wrapped_key,
          },
        ),
    ),
  );
  return out;
}
