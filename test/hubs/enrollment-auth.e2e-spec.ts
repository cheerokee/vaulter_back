import { Controller, Get, type INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { AuthenticateHubTokenUseCase } from '../../src/hubs/application/authenticate-hub-token.use-case.js';
import { ClaimHubUseCase } from '../../src/hubs/application/claim-hub.use-case.js';
import { EnrollHubUseCase } from '../../src/hubs/application/enroll-hub.use-case.js';
import { EnrollmentStatusUseCase } from '../../src/hubs/application/enrollment-status.use-case.js';
import { IssueHubChallengeUseCase } from '../../src/hubs/application/issue-hub-challenge.use-case.js';
import { IssueHubTokenUseCase } from '../../src/hubs/application/issue-hub-token.use-case.js';
import {
  CurrentHub,
  HubAuth,
  type HubAuthContext,
} from '../../src/hubs/infra/http/hub-auth.decorators.js';
import { HubTokenService } from '../../src/identity/application/hub-token-service.js';
import { OrganizationDirectory } from '../../src/organizations/application/organization-directory.js';
import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
  UnauthenticatedError,
} from '../../src/shared/domain/errors.js';
import { newId } from '../../src/shared/domain/id.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import { createClientAccount } from '../support/client-crypto.js';
import {
  createHubIdentity,
  signAuth,
  signEnrollment,
  signStatus,
  type HubIdentity,
} from '../support/hub-crypto.js';
import { identityClient } from '../support/identity-client.js';

// Rota só de teste: exercita o guard de Hub e o @CurrentHub() sem esperar os controllers da Task 9.
@Controller('test-hub-probe')
class HubProbeController {
  @HubAuth()
  @Get()
  whoAmI(@CurrentHub() hub: HubAuthContext): HubAuthContext {
    return hub;
  }
}

const INVALID_CODE = {
  constructor: DomainValidationError,
  code: 'claim-code-invalid',
};
const AUTH_FAILED = {
  constructor: UnauthenticatedError,
  code: 'hub-auth-failed',
};
const nonce = () => randomBytes(16).toString('base64url');

describe('hub enrollment, claim and authentication (e2e)', () => {
  let app: INestApplication;
  let admin: DataSource;
  const c = identityClient(() => app);
  let owner: { userId: string; token: string };
  let rival: { userId: string; token: string };
  const actorOf = (u: { userId: string }) => ({
    userId: u.userId,
    sessionId: newId(),
  });

  const enroll = async (hub: HubIdentity, n = nonce()) => {
    const timestamp = new Date().toISOString();
    return app.get(EnrollHubUseCase).execute({
      signingPublicKey: hub.signingPublicKey,
      encryptionPublicKey: hub.encryptionPublicKey,
      nonce: n,
      timestamp,
      signature: await signEnrollment(hub, { nonce: n, timestamp }),
    });
  };
  const status = async (hub: HubIdentity, enrollmentId: string) => {
    const timestamp = new Date().toISOString();
    return app.get(EnrollmentStatusUseCase).execute({
      enrollmentId,
      timestamp,
      signature: await signStatus(hub, { enrollmentId, timestamp }),
    });
  };
  const claim = (who: { userId: string }, claimCode: string, name = 'Sala') =>
    app.get(ClaimHubUseCase).execute(actorOf(who), { claimCode, name });
  const login = async (hub: HubIdentity, hubId: string) => {
    const { challenge } = await app
      .get(IssueHubChallengeUseCase)
      .execute(hubId);
    return {
      challenge,
      signature: await signAuth(hub, { hubId, challenge }),
    };
  };
  /** Enrolls and claims a fresh hub for the owner. */
  const claimedHub = async () => {
    const identity = await createHubIdentity();
    const { claimCode } = await enroll(identity);
    const view = await claim(owner, claimCode);
    return { identity, hubId: view.id };
  };

  beforeAll(async () => {
    app = await createTestApp({ controllers: [HubProbeController] });
    await resetDatabase();
    admin = await adminDataSource();
    owner = await c.signUp(
      await createClientAccount('correct horse battery staple'),
      'hub-owner@example.com',
    );
    rival = await c.signUp(
      await createClientAccount('correct horse battery staple'),
      'hub-rival@example.com',
      'Rival',
    );
  }, 120_000);
  afterAll(async () => {
    await app.close();
  });

  describe('enrollment', () => {
    it('creates a pending enrollment: the code is 8 digits and only its keyed hash is stored', async () => {
      const identity = await createHubIdentity();
      const res = await enroll(identity);
      expect(res.claimCode).toMatch(/^[0-9]{8}$/);
      const rows: { claim_code_hash: string; status: string }[] =
        await admin.query(
          `SELECT claim_code_hash, status FROM hub_enrollments WHERE id = $1`,
          [res.enrollmentId],
        );
      expect(rows[0]!.status).toBe('pending');
      expect(rows[0]!.claim_code_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]!.claim_code_hash).not.toContain(res.claimCode);
      await expect(status(identity, res.enrollmentId)).resolves.toEqual({
        status: 'pending',
      });
    });

    it('refuses a replayed nonce (409 nonce-reused) and a stale timestamp', async () => {
      const identity = await createHubIdentity();
      const n = nonce();
      const first = await enroll(identity, n);
      await expect(enroll(identity, n)).rejects.toMatchObject({
        constructor: ConflictError,
        code: 'nonce-reused',
      });
      // the replay is rolled back with its expiry: the legitimate pending enrollment survives
      await expect(status(identity, first.enrollmentId)).resolves.toEqual({
        status: 'pending',
      });
      const timestamp = new Date(Date.now() - 6 * 60_000).toISOString();
      const fresh = nonce();
      await expect(
        app.get(EnrollHubUseCase).execute({
          signingPublicKey: identity.signingPublicKey,
          encryptionPublicKey: identity.encryptionPublicKey,
          nonce: fresh,
          timestamp,
          signature: await signEnrollment(identity, {
            nonce: fresh,
            timestamp,
          }),
        }),
      ).rejects.toMatchObject({ code: 'timestamp-out-of-window' });
    });

    it('refuses a key that already belongs to a hub, even a deregistered one (409 signing-key-in-use)', async () => {
      const { identity, hubId } = await claimedHub();
      await expect(enroll(identity)).rejects.toMatchObject({
        constructor: ConflictError,
        code: 'signing-key-in-use',
      });
      await admin.query(`UPDATE hubs SET deleted_at = now() WHERE id = $1`, [
        hubId,
      ]);
      await expect(enroll(identity)).rejects.toMatchObject({
        code: 'signing-key-in-use',
      });
    });

    it('status: the same 404 for a bad signature, an unknown and a malformed enrollment', async () => {
      const identity = await createHubIdentity();
      const intruder = await createHubIdentity();
      const { enrollmentId } = await enroll(identity);
      const notFound = {
        constructor: NotFoundError,
        code: 'enrollment-not-found',
      };
      await expect(status(intruder, enrollmentId)).rejects.toMatchObject(
        notFound,
      );
      await expect(status(identity, newId())).rejects.toMatchObject(notFound);
      await expect(status(identity, 'nope')).rejects.toMatchObject(notFound);
    });
  });

  describe('claim', () => {
    it('creates the hub, links the personal org (approved), grants hub_owner and hub_room, consumes the enrollment and audits', async () => {
      const identity = await createHubIdentity();
      const { enrollmentId, claimCode } = await enroll(identity);
      const view = await claim(owner, claimCode, '  Sala de estar ');
      expect(view).toMatchObject({
        name: 'Sala de estar',
        ownerUserId: owner.userId,
        encryptionPublicKey: identity.encryptionPublicKey,
      });
      const hubId = view.id;
      await expect(status(identity, enrollmentId)).resolves.toEqual({
        status: 'claimed',
        hubId,
      });

      const personalOrgId = await app
        .get(OrganizationDirectory)
        .personalOrganizationIdOf(owner.userId);
      expect(personalOrgId).toEqual(expect.any(String));
      const personal: {
        is_personal: boolean;
        personal_owner_user_id: string;
      }[] = await admin.query(
        `SELECT is_personal, personal_owner_user_id FROM organizations WHERE id = $1`,
        [personalOrgId],
      );
      expect(personal[0]).toEqual({
        is_personal: true,
        personal_owner_user_id: owner.userId,
      });

      const hubRows: { owner_user_id: string; signing_public_key: string }[] =
        await admin.query(
          `SELECT owner_user_id, signing_public_key FROM hubs WHERE id = $1`,
          [hubId],
        );
      expect(hubRows[0]).toEqual({
        owner_user_id: owner.userId,
        signing_public_key: identity.signingPublicKey,
      });

      const roles: {
        key: string;
        user_id: string | null;
        room_hub_id: string | null;
        organization_id: string | null;
      }[] = await admin.query(
        `SELECT r.key, ra.user_id, ra.room_hub_id, ra.organization_id
           FROM role_assignments ra JOIN roles r ON r.id = ra.role_id
          WHERE ra.scope_type = 'hub' AND ra.hub_id = $1 AND ra.deleted_at IS NULL
          ORDER BY r.key`,
        [hubId],
      );
      expect(roles).toEqual([
        {
          key: 'hub_owner',
          user_id: owner.userId,
          room_hub_id: null,
          organization_id: null,
        },
        {
          key: 'hub_room',
          user_id: null,
          room_hub_id: hubId,
          organization_id: null,
        },
      ]);

      const links: { organization_id: string; status: string }[] =
        await admin.query(
          `SELECT organization_id, status FROM hub_organization WHERE hub_id = $1 AND deleted_at IS NULL`,
          [hubId],
        );
      expect(links).toEqual([
        { organization_id: personalOrgId, status: 'approved' },
      ]);

      const audit: {
        organization_id: string;
        user_id: string;
        metadata: unknown;
      }[] = await admin.query(
        `SELECT organization_id, user_id, metadata FROM audit_logs WHERE action = 'hub.claimed' AND metadata->>'hubId' = $1`,
        [hubId],
      );
      expect(audit).toEqual([
        {
          organization_id: personalOrgId,
          user_id: owner.userId,
          metadata: { hubId },
        },
      ]);

      // Código de uso único: a segunda tentativa cai no erro único.
      await expect(claim(rival, claimCode)).rejects.toMatchObject(INVALID_CODE);
    });

    it('wrong, unknown or expired code: the same claim-code-invalid, and nothing is written', async () => {
      const identity = await createHubIdentity();
      const { enrollmentId, claimCode } = await enroll(identity);
      const wrong = claimCode === '00000000' ? '00000001' : '00000000';
      await expect(claim(owner, wrong)).rejects.toMatchObject(INVALID_CODE);
      await expect(claim(owner, 'abc')).rejects.toMatchObject(INVALID_CODE);
      await admin.query(
        `UPDATE hub_enrollments SET expires_at = now() - interval '1 second' WHERE id = $1`,
        [enrollmentId],
      );
      await expect(claim(owner, claimCode)).rejects.toMatchObject(INVALID_CODE);
      const hubs: unknown[] = await admin.query(
        `SELECT 1 FROM hubs WHERE signing_public_key = $1`,
        [identity.signingPublicKey],
      );
      expect(hubs).toHaveLength(0);
      await expect(status(identity, enrollmentId)).resolves.toEqual({
        status: 'expired',
      });
    });

    it('two concurrent claims of the same code: exactly one wins, the other gets claim-code-invalid', async () => {
      const identity = await createHubIdentity();
      const { claimCode } = await enroll(identity);
      const results = await Promise.allSettled([
        claim(owner, claimCode, 'A'),
        claim(rival, claimCode, 'B'),
      ]);
      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r) => r.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect((lost[0] as PromiseRejectedResult).reason).toMatchObject(
        INVALID_CODE,
      );
      const hubs: unknown[] = await admin.query(
        `SELECT 1 FROM hubs WHERE signing_public_key = $1`,
        [identity.signingPublicKey],
      );
      expect(hubs).toHaveLength(1);
    }, 30_000);

    it('a new enrollment of the same key expires the previous pending one: its code dies, one hub at most', async () => {
      const identity = await createHubIdentity();
      const first = await enroll(identity);
      const second = await enroll(identity);
      await expect(status(identity, first.enrollmentId)).resolves.toEqual({
        status: 'expired',
      });
      const results = await Promise.allSettled([
        claim(owner, first.claimCode, 'A'),
        claim(rival, second.claimCode, 'B'),
      ]);
      expect(results[0]).toMatchObject({
        status: 'rejected',
        reason: INVALID_CODE,
      });
      expect(results[1]).toMatchObject({ status: 'fulfilled' });
      const hubs: { id: string }[] = await admin.query(
        `SELECT id FROM hubs WHERE signing_public_key = $1`,
        [identity.signingPublicKey],
      );
      expect(hubs).toHaveLength(1);
      const orphanLinks: unknown[] = await admin.query(
        `SELECT 1 FROM hub_organization ho WHERE NOT EXISTS (SELECT 1 FROM hubs h WHERE h.id = ho.hub_id)`,
      );
      expect(orphanLinks).toHaveLength(0);
      const rows: { id: string; status: string }[] = await admin.query(
        `SELECT id, status FROM hub_enrollments WHERE id = ANY($1)`,
        [[first.enrollmentId, second.enrollmentId]],
      );
      expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
        [first.enrollmentId]: 'expired',
        [second.enrollmentId]: 'claimed',
      });
    }, 30_000);

    it('concurrent enrollments of one key all succeed and leave exactly one pending (unique among pending rows)', async () => {
      const identity = await createHubIdentity();
      const results = await Promise.all(
        Array.from({ length: 4 }, () => enroll(identity)),
      );
      const rows: { id: string; status: string }[] = await admin.query(
        `SELECT id, status FROM hub_enrollments WHERE signing_public_key = $1`,
        [identity.signingPublicKey],
      );
      expect(rows).toHaveLength(4);
      const pending = rows.filter((r) => r.status === 'pending');
      expect(pending).toHaveLength(1);
      expect(results.map((r) => r.enrollmentId)).toContain(pending[0]!.id);
      // the database refuses a second pending row for the key, whatever the code
      const [one] = rows;
      await expect(
        admin.query(
          `INSERT INTO hub_enrollments (signing_public_key, encryption_public_key, nonce, claim_code_hash, expires_at)
           SELECT signing_public_key, encryption_public_key, 'n-dup', repeat('0', 64), now() + interval '10 minutes'
             FROM hub_enrollments WHERE id = $1`,
          [one!.id],
        ),
      ).rejects.toMatchObject({
        driverError: {
          code: '23505',
          constraint: 'uq_hub_enrollments_pending_signing_key',
        },
      });
    }, 30_000);
  });

  describe('hub authentication', () => {
    it('challenge -> token: a hub+jwt for the hub, and last_seen_at is updated', async () => {
      const { identity, hubId } = await claimedHub();
      const before: { last_seen_at: Date | null }[] = await admin.query(
        `SELECT last_seen_at FROM hubs WHERE id = $1`,
        [hubId],
      );
      expect(before[0]!.last_seen_at).toBeNull();

      const proof = await login(identity, hubId);
      const { token, expiresAt } = await app
        .get(IssueHubTokenUseCase)
        .execute({ hubId, ...proof });
      await expect(app.get(HubTokenService).verify(token)).resolves.toEqual({
        hubId,
      });
      const header = JSON.parse(
        Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8'),
      ) as { typ: string };
      expect(header.typ).toBe('hub+jwt');
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

      const after: { last_seen_at: Date | null }[] = await admin.query(
        `SELECT last_seen_at FROM hubs WHERE id = $1`,
        [hubId],
      );
      expect(after[0]!.last_seen_at).toBeInstanceOf(Date);

      // O desafio é de uso único.
      await expect(
        app.get(IssueHubTokenUseCase).execute({ hubId, ...proof }),
      ).rejects.toMatchObject(AUTH_FAILED);
    });

    it('a challenge is consumed once even under concurrency', async () => {
      const { identity, hubId } = await claimedHub();
      const proof = await login(identity, hubId);
      const useCase = app.get(IssueHubTokenUseCase);
      const results = await Promise.allSettled([
        useCase.execute({ hubId, ...proof }),
        useCase.execute({ hubId, ...proof }),
        useCase.execute({ hubId, ...proof }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((x) => x.status === 'rejected')) {
        expect((r as PromiseRejectedResult).reason).toMatchObject(AUTH_FAILED);
      }
    }, 30_000);

    it('an unknown hub gets a challenge that looks valid (hub_id null) and never validates', async () => {
      const { hubId } = await claimedHub();
      const real = await app.get(IssueHubChallengeUseCase).execute(hubId);
      const unknownId = newId();
      const decoy = await app.get(IssueHubChallengeUseCase).execute(unknownId);
      expect(Object.keys(decoy)).toEqual(Object.keys(real));
      expect(decoy.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(
        Math.abs(decoy.expiresAt.getTime() - Date.now() - 60_000),
      ).toBeLessThan(5_000);
      const stored: { hub_id: string | null }[] = await admin.query(
        `SELECT hub_id FROM hub_auth_challenges ORDER BY created_at DESC, id DESC LIMIT 1`,
      );
      expect(stored[0]!.hub_id).toBeNull();

      // Quem tem uma chave qualquer e assina o desafio falso não ganha token.
      const anyone = await createHubIdentity();
      await expect(
        app.get(IssueHubTokenUseCase).execute({
          hubId: unknownId,
          challenge: decoy.challenge,
          signature: await signAuth(anyone, {
            hubId: unknownId,
            challenge: decoy.challenge,
          }),
        }),
      ).rejects.toMatchObject(AUTH_FAILED);
    });

    it('a deregistered hub is refused: decoy challenge, no token, and its old token stops working', async () => {
      const { identity, hubId } = await claimedHub();
      const proof = await login(identity, hubId);
      const { token } = await app
        .get(IssueHubTokenUseCase)
        .execute({ hubId, ...proof });
      await expect(
        app.get(AuthenticateHubTokenUseCase).execute(token),
      ).resolves.toEqual({ hubId });

      await admin.query(`UPDATE hubs SET deleted_at = now() WHERE id = $1`, [
        hubId,
      ]);
      await expect(
        app.get(AuthenticateHubTokenUseCase).execute(token),
      ).rejects.toMatchObject({ code: 'invalid-hub-token' });
      const again = await login(identity, hubId);
      const stored: { hub_id: string | null }[] = await admin.query(
        `SELECT hub_id FROM hub_auth_challenges ORDER BY created_at DESC, id DESC LIMIT 1`,
      );
      expect(stored[0]!.hub_id).toBeNull();
      await expect(
        app.get(IssueHubTokenUseCase).execute({ hubId, ...again }),
      ).rejects.toMatchObject(AUTH_FAILED);
    });
  });

  describe('guards (HTTP, test-only route)', () => {
    it('the hub guard accepts a hub token and exposes @CurrentHub(); it refuses user tokens and no token', async () => {
      const { identity, hubId } = await claimedHub();
      const { token } = await app
        .get(IssueHubTokenUseCase)
        .execute({ hubId, ...(await login(identity, hubId)) });

      const ok = await c
        .http()
        .get('/test-hub-probe')
        .set(c.bearer(token))
        .expect(200);
      expect(ok.body).toEqual({ hubId });

      const userToken = await c
        .http()
        .get('/test-hub-probe')
        .set(c.bearer(owner.token))
        .expect(401);
      expect(userToken.body.type).toMatch(/\/invalid-hub-token$/);
      expect(userToken.headers['content-type']).toMatch(
        /application\/problem\+json/,
      );

      const none = await c.http().get('/test-hub-probe').expect(401);
      expect(none.body.type).toMatch(/\/invalid-hub-token$/);
    });

    it('the user guard refuses a hub token on a user route', async () => {
      const { identity, hubId } = await claimedHub();
      const { token } = await app
        .get(IssueHubTokenUseCase)
        .execute({ hubId, ...(await login(identity, hubId)) });
      const res = await c.http().get('/me').set(c.bearer(token)).expect(401);
      expect(res.body.type).toMatch(/\/invalid-access-token$/);
      await c.http().get('/me').set(c.bearer(owner.token)).expect(200);
    });

    it('a deregistered hub token gets 401 on the hub route', async () => {
      const { identity, hubId } = await claimedHub();
      const { token } = await app
        .get(IssueHubTokenUseCase)
        .execute({ hubId, ...(await login(identity, hubId)) });
      await admin.query(`UPDATE hubs SET deleted_at = now() WHERE id = $1`, [
        hubId,
      ]);
      const res = await c
        .http()
        .get('/test-hub-probe')
        .set(c.bearer(token))
        .expect(401);
      expect(res.body.type).toMatch(/\/invalid-hub-token$/);
    });
  });
});
