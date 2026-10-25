import { adminDataSource } from '../setup/test-app.js';

// Leituras diretas no banco (papel dono, sem RLS) para conferir invariantes dos espaços nos e2e.

/** Active space members (user ids, sorted). */
export async function activeSpaceMembers(spaceId: string): Promise<string[]> {
  const rows: { user_id: string }[] = await (
    await adminDataSource()
  ).query(
    `SELECT user_id FROM role_assignments
      WHERE scope_type = 'space' AND space_id = $1 AND deleted_at IS NULL
      ORDER BY user_id`,
    [spaceId],
  );
  return rows.map((r) => r.user_id);
}

/** Pairs (member, version) where an active member has no active copy of an existing version. */
export async function membersMissingVersions(
  spaceId: string,
): Promise<{ user_id: string; version: number }[]> {
  return (await adminDataSource()).query(
    `SELECT ra.user_id, sk.version
       FROM role_assignments ra
       JOIN space_keys sk ON sk.space_id = ra.space_id AND sk.deleted_at IS NULL
       LEFT JOIN space_key_grants g
         ON g.space_key_id = sk.id AND g.user_id = ra.user_id AND g.deleted_at IS NULL
      WHERE ra.scope_type = 'space' AND ra.space_id = $1 AND ra.deleted_at IS NULL AND g.id IS NULL
      ORDER BY ra.user_id, sk.version`,
    [spaceId],
  );
}

/** Active user copies of this space held by someone who is NOT an active member. */
export async function grantsOfNonMembers(
  spaceId: string,
): Promise<{ user_id: string; version: number }[]> {
  return (await adminDataSource()).query(
    `SELECT g.user_id, sk.version
       FROM space_key_grants g
       JOIN space_keys sk ON sk.id = g.space_key_id
      WHERE sk.space_id = $1 AND g.deleted_at IS NULL AND g.user_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM role_assignments ra
           WHERE ra.scope_type = 'space' AND ra.space_id = sk.space_id
             AND ra.user_id = g.user_id AND ra.deleted_at IS NULL)
      ORDER BY g.user_id, sk.version`,
    [spaceId],
  );
}

/** Versions for which the user ever had a copy (active or tombstoned). */
export async function versionsEverGranted(
  spaceId: string,
  userId: string,
): Promise<number[]> {
  const rows: { version: number }[] = await (
    await adminDataSource()
  ).query(
    `SELECT DISTINCT sk.version FROM space_key_grants g
       JOIN space_keys sk ON sk.id = g.space_key_id
      WHERE sk.space_id = $1 AND g.user_id = $2 ORDER BY sk.version`,
    [spaceId, userId],
  );
  return rows.map((r) => r.version);
}

export async function spaceRow(spaceId: string): Promise<{
  current_key_version: number;
  key_rotation_required: boolean;
}> {
  const rows: {
    current_key_version: number;
    key_rotation_required: boolean;
  }[] = await (
    await adminDataSource()
  ).query(
    `SELECT current_key_version, key_rotation_required FROM spaces WHERE id = $1`,
    [spaceId],
  );
  return rows[0]!;
}

/** Audit rows of an organization whose action starts with `prefix`, oldest first. */
export async function auditRows(
  orgId: string,
  prefix = 'space.',
): Promise<
  {
    action: string;
    user_id: string | null;
    metadata: Record<string, unknown>;
  }[]
> {
  return (await adminDataSource()).query(
    `SELECT action, user_id, metadata FROM audit_logs
      WHERE organization_id = $1 AND action LIKE $2 ORDER BY created_at, id`,
    [orgId, `${prefix}%`],
  );
}
