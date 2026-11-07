import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { grantPlatformAdmin } from '../../scripts/platform-grant-admin.js';
import type { PlatformRoleKey } from '../../src/platform/domain/platform-catalog.js';
import { adminDataSource } from '../setup/test-app.js';

/** Runs `work` with a raw pg client of the owner login on the test database (what the CLI uses). */
export async function withOwnerClient<T>(
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** The first admin, exactly as `npm run platform:grant-admin -- <email>` does it. */
export const grantAdminByCli = (email: string) =>
  withOwnerClient((client) => grantPlatformAdmin(client, email));

/**
 * Forces a race: holds FOR UPDATE on every live platform role assignment, starts `requests`, waits until
 * `expectedWaiters` runtime connections are blocked on a lock, then releases. Without the lock in the use case,
 * each request would already have read the same admins and both would go through once released.
 */
export async function raceUnderStaffLock<T>(
  requests: () => Promise<T>[],
  expectedWaiters: number,
): Promise<T[]> {
  return withOwnerClient(async (client) => {
    await client.query('BEGIN');
    await client.query(
      `SELECT 1 FROM user_platform_role WHERE deleted_at IS NULL FOR UPDATE`,
    );
    const pending = requests();
    // Settled results are read after the release; a rejection here must not go unhandled while polling.
    const all = Promise.allSettled(pending);
    try {
      const deadline = Date.now() + 4_000;
      for (;;) {
        // pg_stat_activity is snapshotted once per transaction: refresh it on every poll.
        await client.query('SELECT pg_stat_clear_snapshot()');
        const { rows } = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND usename = $1 AND wait_event_type = 'Lock'`,
          [process.env.DB_APP_USERNAME],
        );
        if (rows[0].n >= expectedWaiters) break;
        if (Date.now() > deadline) {
          throw new Error(
            `raceUnderStaffLock: only ${rows[0].n} of ${expectedWaiters} requests reached the lock`,
          );
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    } finally {
      await client.query('COMMIT');
    }
    return (await all).map((r) => {
      if (r.status === 'rejected') throw r.reason;
      return r.value;
    });
  });
}

/** Gives a platform role straight in the database (owner login), bypassing the routes. */
export async function grantRoleInDb(
  userId: string,
  roleKey: PlatformRoleKey,
): Promise<void> {
  const ds = await adminDataSource();
  await ds.query(
    `INSERT INTO user_platform_role (user_id, platform_role_id)
     SELECT $1, id FROM platform_roles WHERE key = $2 AND deleted_at IS NULL
     ON CONFLICT (user_id, platform_role_id) DO UPDATE SET deleted_at = NULL`,
    [userId, roleKey],
  );
}

export type PlatformAuditRow = {
  user_id: string | null;
  action: string;
  result: string;
  target_user_id: string | null;
  metadata: Record<string, unknown> | null;
};

export async function platformAuditRows(): Promise<PlatformAuditRow[]> {
  const ds = await adminDataSource();
  return ds.query(
    `SELECT user_id, action, result, target_user_id, metadata
       FROM platform_audit_logs ORDER BY id`,
  );
}

/** HTTP helpers for the /platform routes. */
export function platformClient(getApp: () => INestApplication) {
  const http = () => request(getApp().getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  return {
    me: (token: string) => http().get('/platform/me').set(auth(token)),
    staff: (token: string, query: Record<string, string | number> = {}) =>
      http().get('/platform/staff').query(query).set(auth(token)),
    grant: (
      token: string,
      userId: string,
      roleKey: string,
      currentAuthProof: string,
    ) =>
      http()
        .put(`/platform/staff/${userId}/roles/${roleKey}`)
        .set(auth(token))
        .send({ currentAuthProof }),
    revoke: (
      token: string,
      userId: string,
      roleKey: string,
      currentAuthProof: string,
    ) =>
      http()
        .delete(`/platform/staff/${userId}/roles/${roleKey}`)
        .set(auth(token))
        .send({ currentAuthProof }),
    createRequest: (token: string, body: Record<string, unknown>) =>
      http().post('/platform/support-requests').set(auth(token)).send(body),
    approveRequest: (token: string, id: string, currentAuthProof: string) =>
      http()
        .post(`/platform/support-requests/${id}/approve`)
        .set(auth(token))
        .send({ currentAuthProof }),
    rejectRequest: (
      token: string,
      id: string,
      note: string,
      currentAuthProof: string,
    ) =>
      http()
        .post(`/platform/support-requests/${id}/reject`)
        .set(auth(token))
        .send({ note, currentAuthProof }),
    listRequests: (
      token: string,
      query: Record<string, string | number> = {},
    ) => http().get('/platform/support-requests').query(query).set(auth(token)),
    getRequest: (token: string, id: string) =>
      http().get(`/platform/support-requests/${id}`).set(auth(token)),
  };
}

export type PlatformRequestAuditRow = PlatformAuditRow & {
  support_request_id: string | null;
  target_hub_id: string | null;
  target_organization_id: string | null;
};

/** The platform trail of one support request, in order. */
export async function requestAuditRows(
  supportRequestId: string,
): Promise<PlatformRequestAuditRow[]> {
  const ds = await adminDataSource();
  return ds.query(
    `SELECT user_id, action, result, support_request_id, target_user_id, target_hub_id,
            target_organization_id, metadata
       FROM platform_audit_logs WHERE support_request_id = $1 ORDER BY id`,
    [supportRequestId],
  );
}
