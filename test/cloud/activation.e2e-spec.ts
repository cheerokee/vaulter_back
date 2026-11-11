import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import sodium from 'libsodium-wrappers-sumo';
import { CloudSpaceJobs } from '../../src/cloud/application/cloud-space-jobs.js';
import { ServerKeyring } from '../../src/cloud/application/ports/server-keyring.js';
import { JobQueue } from '../../src/shared/application/job-queue.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import { generateSpaceKey, sealSpaceKey } from '../support/client-crypto.js';
import {
  expectStatus,
  identityClient,
  recipientOf,
  type KeyedUser,
} from '../support/identity-client.js';

const TEST_QUEUE = 'cloud.test-space-job';

describe('active cloud: term, authorize, switch on, switch off (e2e, real client crypto)', () => {
  let app: INestApplication;
  const c = identityClient(() => app);
  const auth = (u: KeyedUser) => c.bearer(u.token);

  /** Every version (keys[i] = version i + 1) sealed for the server key, as the manager's app does. */
  const serverGrants = async (u: KeyedUser, keys: Uint8Array[]) => {
    const serverPk = await c.spaces.serverPublicKey(u.token);
    return Promise.all(
      keys.map(async (key, i) => ({
        version: i + 1,
        wrappedKey: await sealSpaceKey(key, serverPk),
      })),
    );
  };
  const terms = (u: KeyedUser, orgId: string) =>
    c.http().get(`/organizations/${orgId}/cloud/terms`).set(auth(u));
  const accept = (u: KeyedUser, orgId: string, version: number, hash: string) =>
    c
      .http()
      .post(`/organizations/${orgId}/cloud/terms/accept`)
      .set(auth(u))
      .send({ version, hash });
  const acceptCurrent = async (u: KeyedUser, orgId: string) => {
    const cur = (await expectStatus(terms(u, orgId), 200)).body.current;
    return expectStatus(accept(u, orgId, cur.version, cur.hash), 200);
  };
  const authorize = (u: KeyedUser, spaceId: string) =>
    c.http().post(`/spaces/${spaceId}/cloud/authorize`).set(auth(u)).send({});
  const activate = (u: KeyedUser, spaceId: string, grants: unknown) =>
    c
      .http()
      .post(`/spaces/${spaceId}/cloud/activate`)
      .set(auth(u))
      .send({ serverGrants: grants });
  const deactivate = (u: KeyedUser, spaceId: string) =>
    c.http().post(`/spaces/${spaceId}/cloud/deactivate`).set(auth(u)).send({});
  const cloudState = (u: KeyedUser, spaceId: string) =>
    c.http().get(`/spaces/${spaceId}/cloud`).set(auth(u));

  const db = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await adminDataSource()).query(sql, params);
  const auditActions = async (orgId: string) =>
    (
      await db<{ action: string }>(
        `SELECT action FROM audit_logs WHERE organization_id = $1 AND action LIKE '%cloud%' ORDER BY created_at, id`,
        [orgId],
      )
    ).map((r) => r.action);

  beforeAll(async () => {
    await sodium.ready;
    await resetDatabase();
    app = await createTestApp();
    app.get(CloudSpaceJobs).register(TEST_QUEUE);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  describe('a company organization', () => {
    // ana: owner/admin and the space's creator (manager); carol: admin outside the space (decides); bob: manager
    // without org permission; dave: reader.
    let ana: KeyedUser;
    let bob: KeyedUser;
    let carol: KeyedUser;
    let dave: KeyedUser;
    let orgId: string;
    let kitPk: string;
    let spaceId: string;
    const keys: Uint8Array[] = [];

    beforeAll(async () => {
      ana = await c.spaces.signUpKeyed('ana@example.com', 'Ana');
      bob = await c.spaces.signUpKeyed('bob@example.com', 'Bob');
      carol = await c.spaces.signUpKeyed('carol@example.com', 'Carol');
      dave = await c.spaces.signUpKeyed('dave@example.com', 'Dave');
      const org = await c.spaces.orgWithKit(ana);
      orgId = org.orgId;
      kitPk = org.kit.publicKey;
      await c.spaces.joinOrg(ana, orgId, bob);
      await c.spaces.joinOrg(ana, orgId, carol, 'org_admin');
      await c.spaces.joinOrg(ana, orgId, dave);
      const created = await c.spaces.create(ana, orgId, kitPk);
      expect(created.res.status).toBe(201);
      spaceId = created.spaceId;
      keys.push(created.key);
      await expectStatus(
        c.spaces.addMember(
          ana.token,
          spaceId,
          recipientOf(bob),
          keys,
          'space_manager',
        ),
        201,
      );
      await expectStatus(
        c.spaces.addMember(
          ana.token,
          spaceId,
          recipientOf(dave),
          keys,
          'space_reader',
        ),
        201,
      );
    }, 60_000);

    it('every member reads the current term (hash = SHA-256 of the text); nobody accepted yet', async () => {
      const res = await expectStatus(terms(dave, orgId), 200);
      expect(res.body.accepted).toBeNull();
      expect(res.body.current.version).toBe(1);
      expect(res.body.current.hash).toBe(
        createHash('sha256')
          .update(res.body.current.text, 'utf8')
          .digest('hex'),
      );
      const eve = await c.spaces.signUpKeyed('eve@example.com');
      await terms(eve, orgId).expect(404);
    });

    it('authorizing before the term is accepted: 422 cloud-terms-not-accepted', async () => {
      const res = await authorize(carol, spaceId);
      expect(res.status).toBe(422);
      expect(res.body.type).toMatch(/cloud-terms-not-accepted$/);
    });

    it('accepting: only whoever decides, with the version and hash shown; repeated = the same acceptance', async () => {
      const cur = (await expectStatus(terms(carol, orgId), 200)).body.current;
      await accept(bob, orgId, cur.version, cur.hash).expect(403);
      const stale = await accept(carol, orgId, cur.version, 'e'.repeat(64));
      expect(stale.status).toBe(422);
      expect(stale.body.type).toMatch(/cloud-terms-outdated$/);
      const first = await expectStatus(
        accept(carol, orgId, cur.version, cur.hash),
        200,
      );
      expect(first.body).toMatchObject({
        version: 1,
        hash: cur.hash,
        acceptedByUserId: carol.userId,
      });
      const again = await expectStatus(
        accept(ana, orgId, cur.version, cur.hash),
        200,
      );
      expect(again.body).toEqual(first.body);
      const rows = await db<{ accepted_by_user_id: string; ip: string | null }>(
        `SELECT accepted_by_user_id, ip FROM cloud_term_acceptances WHERE organization_id = $1`,
        [orgId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.accepted_by_user_id).toBe(carol.userId);
      expect(rows[0]!.ip).toBeTruthy();
      expect(await auditActions(orgId)).toEqual([
        'organization.cloud_terms.accepted',
      ]);
    });

    it('the manager cannot switch on before the authorization; a member without the permission cannot authorize', async () => {
      const early = await activate(bob, spaceId, await serverGrants(bob, keys));
      expect(early.status).toBe(422);
      expect(early.body.type).toMatch(/cloud-not-authorized$/);
      await authorize(bob, spaceId).expect(403);
      await authorize(dave, spaceId).expect(403);
    });

    it('the admin outside the space authorizes; every member and the admin see "authorized"', async () => {
      const res = await expectStatus(authorize(carol, spaceId), 200);
      expect(res.body).toMatchObject({
        spaceId,
        state: 'authorized',
        termVersion: 1,
        authorizedByUserId: carol.userId,
        activatedAt: null,
      });
      // Idempotent.
      await expectStatus(authorize(carol, spaceId), 200);
      for (const u of [carol, bob, dave]) {
        expect(
          (await expectStatus(cloudState(u, spaceId), 200)).body.state,
        ).toBe('authorized');
      }
      const space = await expectStatus(
        c.http().get(`/spaces/${spaceId}`).set(auth(dave)),
        200,
      );
      expect(space.body.cloud).toEqual({
        mode: 'encrypted_backup',
        activatedAt: null,
      });
    });

    it('the admin who is not in the space cannot send the key (404); a reader cannot (403)', async () => {
      const grants = await serverGrants(carol, keys);
      const res = await activate(carol, spaceId, grants);
      expect(res.status).toBe(404);
      expect(res.body.type).toMatch(/space-not-found$/);
      await activate(dave, spaceId, grants).expect(403);
    });

    it('a copy not sealed to the server key: 422 server-copy-invalid; a missing version: 409', async () => {
      const other = sodium.crypto_box_keypair();
      const wrong = await sealSpaceKey(
        keys[0]!,
        Buffer.from(other.publicKey).toString('base64url'),
      );
      const bad = await activate(bob, spaceId, [
        { version: 1, wrappedKey: wrong },
      ]);
      expect(bad.status).toBe(422);
      expect(bad.body.type).toMatch(/server-copy-invalid$/);
      const missing = await activate(bob, spaceId, [
        ...(await serverGrants(bob, keys)),
        { version: 2, wrappedKey: wrong },
      ]);
      expect(missing.status).toBe(409);
      expect(missing.body).toMatchObject({ unexpectedVersions: [2] });
      const [{ n }] = await db<{ n: number }>(
        `SELECT count(*)::int AS n FROM cloud_space_key_grants WHERE space_id = $1`,
        [spaceId],
      );
      expect(n).toBe(0);
    });

    it('the manager switches on: the server holds a copy that opens to the space key; every member sees the cloud', async () => {
      const res = await expectStatus(
        activate(bob, spaceId, await serverGrants(bob, keys)),
        200,
      );
      expect(res.body).toMatchObject({
        state: 'active',
        activatedByUserId: bob.userId,
      });
      await activate(bob, spaceId, await serverGrants(bob, keys)).expect(409);
      for (const u of [ana, bob, dave]) {
        const space = await expectStatus(
          c.http().get(`/spaces/${spaceId}`).set(auth(u)),
          200,
        );
        expect(space.body.cloud.mode).toBe('active_cloud');
        expect(space.body.cloud.activatedAt).toBe(res.body.activatedAt);
      }
      const rows = await db<{ key_version: number; wrapped_key: string }>(
        `SELECT key_version, wrapped_key FROM cloud_space_key_grants WHERE space_id = $1 ORDER BY key_version`,
        [spaceId],
      );
      expect(rows.map((r) => r.key_version)).toEqual([1]);
      const opened = await app
        .get(ServerKeyring)
        .openSealed(rows[0]!.wrapped_key);
      expect(Buffer.from(opened).equals(Buffer.from(keys[0]!))).toBe(true);
      sodium.memzero(opened);
      expect(await auditActions(orgId)).toEqual([
        'organization.cloud_terms.accepted',
        'space.cloud.authorized',
        'space.cloud.activated',
      ]);
      const audit = await db<{ metadata: unknown }>(
        `SELECT metadata FROM audit_logs WHERE organization_id = $1 AND action LIKE 'space.cloud.%'`,
        [orgId],
      );
      expect(JSON.stringify(audit)).not.toContain(rows[0]!.wrapped_key);
    });

    it('a key rotation without the server copy: 409 missingServer and nothing written; with it, stored', async () => {
      const key2 = await generateSpaceKey();
      const recipients = await c.spaces.memberRecipients(bob.token, spaceId);
      const without = await c.spaces.rotate(bob.token, spaceId, {
        version: 2,
        key: key2,
        recipients,
        kitPublicKey: kitPk,
        server: false,
      });
      expect(without.status).toBe(409);
      expect(without.body).toMatchObject({ missingServer: true });
      expect(without.body.type).toMatch(/key-rotation-mismatch$/);
      const [state] = await db<{ v: number; keys: number }>(
        `SELECT s.current_key_version AS v,
                (SELECT count(*)::int FROM space_keys k WHERE k.space_id = s.id) AS keys
           FROM spaces s WHERE s.id = $1`,
        [spaceId],
      );
      expect(state).toEqual({ v: 1, keys: 1 });

      // A copy sealed to another key: the cloud refuses it and the whole rotation is undone.
      const other = sodium.crypto_box_keypair();
      const wrongServer = await c
        .http()
        .post(`/spaces/${spaceId}/keys`)
        .set(auth(bob))
        .send({
          version: 2,
          recoveryPublicKey: kitPk,
          recoveryWrappedKey: await sealSpaceKey(key2, kitPk),
          grants: await Promise.all(
            recipients.map(async (r) => ({
              userId: r.userId,
              wrappedKey: await sealSpaceKey(key2, r.publicKey),
            })),
          ),
          hubGrants: [],
          serverWrappedKey: await sealSpaceKey(
            key2,
            Buffer.from(other.publicKey).toString('base64url'),
          ),
        });
      expect(wrongServer.status).toBe(422);
      expect(wrongServer.body.type).toMatch(/server-copy-invalid$/);
      expect(
        (
          await db<{ v: number }>(
            `SELECT current_key_version AS v FROM spaces WHERE id = $1`,
            [spaceId],
          )
        )[0]!.v,
      ).toBe(1);

      await expectStatus(
        c.spaces.rotate(bob.token, spaceId, {
          version: 2,
          key: key2,
          recipients,
          kitPublicKey: kitPk,
        }),
        201,
      );
      keys.push(key2);
      const rows = await db<{ key_version: number; wrapped_key: string }>(
        `SELECT key_version, wrapped_key FROM cloud_space_key_grants WHERE space_id = $1 ORDER BY key_version`,
        [spaceId],
      );
      expect(rows.map((r) => r.key_version)).toEqual([1, 2]);
      const opened = await app
        .get(ServerKeyring)
        .openSealed(rows[1]!.wrapped_key);
      expect(Buffer.from(opened).equals(Buffer.from(key2))).toBe(true);
      sodium.memzero(opened);
    });

    it('switching off deletes the server copies for real, cancels waiting jobs and goes back to encrypted_backup', async () => {
      const queue = app.get(JobQueue);
      await queue.send(TEST_QUEUE, { organizationId: orgId, spaceId });
      const otherSpaceId = '019a0000-0000-7000-8000-00000000ffff';
      await queue.send(TEST_QUEUE, {
        organizationId: orgId,
        spaceId: otherSpaceId,
      });
      // A reader cannot switch off; the admin outside the space can.
      await deactivate(dave, spaceId).expect(403);
      await deactivate(carol, spaceId).expect(204);

      const [{ n }] = await db<{ n: number }>(
        `SELECT count(*)::int AS n FROM cloud_space_key_grants`,
      );
      expect(n).toBe(0);
      const jobs = await db<{ space_id: string }>(
        `SELECT data->>'spaceId' AS space_id FROM pgboss.job WHERE name = $1`,
        [TEST_QUEUE],
      );
      expect(jobs.map((j) => j.space_id)).toEqual([otherSpaceId]);
      const [row] = await db<{
        cloud_mode: string;
        cloud_activated_at: Date | null;
      }>(`SELECT cloud_mode, cloud_activated_at FROM spaces WHERE id = $1`, [
        spaceId,
      ]);
      expect(row).toEqual({
        cloud_mode: 'encrypted_backup',
        cloud_activated_at: null,
      });
      const cycles = await db<{
        deleted_at: Date | null;
        deactivated_by_user_id: string;
      }>(
        `SELECT deleted_at, deactivated_by_user_id FROM cloud_space_activations WHERE space_id = $1`,
        [spaceId],
      );
      expect(cycles).toHaveLength(1);
      expect(cycles[0]!.deleted_at).not.toBeNull();
      expect(cycles[0]!.deactivated_by_user_id).toBe(carol.userId);
      expect(
        (await expectStatus(cloudState(dave, spaceId), 200)).body.state,
      ).toBe('off');
      expect((await auditActions(orgId)).at(-1)).toBe(
        'space.cloud.deactivated',
      );
      // Idempotent.
      await deactivate(bob, spaceId).expect(204);
      expect(
        (await auditActions(orgId)).filter(
          (a) => a === 'space.cloud.deactivated',
        ),
      ).toHaveLength(1);
    });

    it('after switching off, a rotation with a server copy is refused (unexpectedServer)', async () => {
      const key3 = await generateSpaceKey();
      const res = await c.spaces.rotate(bob.token, spaceId, {
        version: 3,
        key: key3,
        recipients: await c.spaces.memberRecipients(bob.token, spaceId),
        kitPublicKey: kitPk,
        server: true,
      });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ unexpectedServer: true });
    });

    it('the manager may switch off too, and a later cycle starts a new row (history kept)', async () => {
      await expectStatus(authorize(carol, spaceId), 200);
      await expectStatus(
        activate(bob, spaceId, await serverGrants(bob, keys)),
        200,
      );
      await deactivate(bob, spaceId).expect(204);
      const cycles = await db<{ n: number }>(
        `SELECT count(*)::int AS n FROM cloud_space_activations WHERE space_id = $1 AND deleted_at IS NOT NULL`,
        [spaceId],
      );
      expect(cycles[0]!.n).toBe(2);
    });

    it('an orphan space cannot be authorized (nobody can send the key)', async () => {
      const orphan = await c.spaces.create(ana, orgId, kitPk, 'Orfao');
      await c
        .http()
        .post(`/spaces/${orphan.spaceId}/leave`)
        .set(auth(ana))
        .expect(204);
      const res = await authorize(carol, orphan.spaceId);
      expect(res.status).toBe(422);
      expect(res.body.type).toMatch(/space-orphaned$/);
    });

    it('a new term version must be accepted before authorizing a new space; spaces already on stay on', async () => {
      // Space A on under v1.
      await expectStatus(authorize(carol, spaceId), 200);
      await expectStatus(
        activate(bob, spaceId, await serverGrants(bob, keys)),
        200,
      );
      const other = await c.spaces.create(ana, orgId, kitPk, 'Outro');
      await db(
        `INSERT INTO cloud_terms (version, hash, text, published_at)
         VALUES (2, encode(sha256(convert_to('v2', 'UTF8')), 'hex'), 'v2', now())`,
      );
      const res = await authorize(carol, other.spaceId);
      expect(res.status).toBe(422);
      expect(res.body.type).toMatch(/cloud-terms-not-accepted$/);
      expect(
        (await expectStatus(cloudState(bob, spaceId), 200)).body.state,
      ).toBe('active');
      await acceptCurrent(carol, orgId);
      await expectStatus(authorize(carol, other.spaceId), 200);
      await db(`DELETE FROM cloud_space_activations WHERE term_version = 2`);
      await db(`DELETE FROM cloud_term_acceptances WHERE term_version = 2`);
      await db(`DELETE FROM cloud_terms WHERE version = 2`);
    });

    it('the runtime cannot publish or rewrite a term, nor rewrite an acceptance; it can delete server copies', async () => {
      const priv = async (table: string, p: string) =>
        (
          await db<{ ok: boolean }>(
            `SELECT has_table_privilege('app_runtime', $1, $2) AS ok`,
            [table, p],
          )
        )[0]!.ok;
      expect(await priv('cloud_terms', 'INSERT')).toBe(false);
      expect(await priv('cloud_terms', 'UPDATE')).toBe(false);
      expect(await priv('cloud_term_acceptances', 'UPDATE')).toBe(false);
      expect(await priv('cloud_term_acceptances', 'DELETE')).toBe(false);
      expect(await priv('cloud_space_activations', 'DELETE')).toBe(false);
      expect(await priv('cloud_space_key_grants', 'DELETE')).toBe(true);
    });
  });

  it('personal organization: the same person accepts, authorizes and switches on', async () => {
    const zoe = await c.spaces.signUpKeyed('zoe@example.com', 'Zoe');
    const orgs = await expectStatus(
      c.http().get('/organizations').set(auth(zoe)),
      200,
    );
    const personal = (
      orgs.body.items as { id: string; isPersonal: boolean }[]
    ).find((o) => o.isPersonal)!;
    const kit = await import('../support/client-crypto.js').then((m) =>
      m.recoveryKitKeypair(),
    );
    await c.spaces.setRecoveryKit(zoe, personal.id, kit.publicKey).expect(204);
    const created = await c.spaces.create(zoe, personal.id, kit.publicKey);
    await acceptCurrent(zoe, personal.id);
    await expectStatus(authorize(zoe, created.spaceId), 200);
    const res = await expectStatus(
      activate(zoe, created.spaceId, await serverGrants(zoe, [created.key])),
      200,
    );
    expect(res.body.state).toBe('active');
  });
});
