import type { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import {
  createHubIdentity,
  signAuth,
  signEnrollment,
  signStatus,
  type HubIdentity,
} from './hub-crypto.js';
import type { ClaimedHub } from './hubs-kit.js';

export type SyncItem = {
  type: string;
  syncVersion: number;
  deleted: boolean;
  data: Record<string, unknown>;
};
export type SyncPage = { items: SyncItem[]; nextSince: number };

/** An enrolled (not yet claimed) device: what it shows or says to its owner is `claimCode`. */
export type EnrolledHub = {
  identity: HubIdentity;
  enrollmentId: string;
  claimCode: string;
};

const fail = (what: string, res: request.Response): never => {
  throw new Error(
    `${what}: HTTP ${res.status} ${JSON.stringify(res.body as unknown)}`,
  );
};

/**
 * The Hub device over HTTP, with the REAL hub crypto (docs/crypto/hub-identity.md): generates its keys, enrolls,
 * polls the enrollment status with signed headers, authenticates (challenge + token), asks for link codes and
 * syncs. The private keys never leave this object. The raw request helpers return the supertest request, so a spec
 * can assert errors (opening a sealed copy is `hubsKit().hubOpens`); the flow helpers (`enrolled`, `waitClaimed`, `authenticate`, `syncAll`) throw on a non-2xx.
 */
export function hubClient(getApp: () => INestApplication) {
  const http = () => request(getApp().getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  const enrollBody = async (
    identity: HubIdentity,
    over: { nonce?: string; timestamp?: string; signature?: string } = {},
  ) => {
    const nonce = over.nonce ?? randomBytes(16).toString('base64url');
    const timestamp = over.timestamp ?? new Date().toISOString();
    return {
      signingPublicKey: identity.signingPublicKey,
      encryptionPublicKey: identity.encryptionPublicKey,
      nonce,
      timestamp,
      signature:
        over.signature ??
        (await signEnrollment(identity, { nonce, timestamp })),
    };
  };

  const enroll = async (
    identity: HubIdentity,
    over: Parameters<typeof enrollBody>[1] = {},
  ) =>
    http()
      .post('/hub-enrollments')
      .send(await enrollBody(identity, over));

  /** GET /hub-enrollments/:id/status with `X-Hub-Signature` / `X-Hub-Timestamp` (overridable to forge). */
  const status = async (
    identity: HubIdentity,
    enrollmentId: string,
    over: { timestamp?: string; signature?: string } = {},
  ) => {
    const timestamp = over.timestamp ?? new Date().toISOString();
    const signature =
      over.signature ??
      (await signStatus(identity, { enrollmentId, timestamp }));
    return http()
      .get(`/hub-enrollments/${enrollmentId}/status`)
      .set('X-Hub-Signature', signature)
      .set('X-Hub-Timestamp', timestamp);
  };

  const challenge = (hubId: string) =>
    http().post('/hub-auth/challenge').send({ hubId });

  const token = async (
    identity: HubIdentity,
    hubId: string,
    challengeValue: string,
    signature?: string,
  ) =>
    http()
      .post('/hub-auth/token')
      .send({
        hubId,
        challenge: challengeValue,
        signature:
          signature ??
          (await signAuth(identity, { hubId, challenge: challengeValue })),
      });

  /** Challenge then token: the hub access token. */
  const authenticate = async (hub: ClaimedHub): Promise<string> => {
    const ch = await challenge(hub.hubId);
    if (ch.status !== 200) fail('challenge', ch);
    const res = await token(hub.identity, hub.hubId, ch.body.challenge);
    if (res.status !== 200) fail('token', res);
    return res.body.accessToken as string;
  };

  const sync = (accessToken: string, query: Record<string, number> = {}) =>
    http().get('/hub/sync').query(query).set(bearer(accessToken));

  /** Every page from `since`, following `nextSince` until an empty page. */
  const syncAll = async (accessToken: string, since = 0, limit = 500) => {
    const items: SyncItem[] = [];
    for (let i = 0; i < 1000; i++) {
      const res = await sync(accessToken, { since, limit });
      if (res.status !== 200) fail('sync', res);
      const page = res.body as SyncPage;
      if (page.items.length === 0) return { items, since };
      items.push(...page.items);
      since = page.nextSince;
    }
    throw new Error('syncAll: too many pages');
  };

  const linkCode = (accessToken: string) =>
    http().post('/hub/link-codes').set(bearer(accessToken)).send();

  /** Polls the status until it is `claimed` (a few tries; the claim already happened in the tests). */
  const waitClaimed = async (device: EnrolledHub): Promise<ClaimedHub> => {
    for (let i = 0; i < 5; i++) {
      const res = await status(device.identity, device.enrollmentId);
      if (res.status !== 200) fail('status', res);
      if (res.body.status === 'claimed') {
        return { hubId: res.body.hubId as string, identity: device.identity };
      }
    }
    throw new Error('waitClaimed: the enrollment was not claimed');
  };

  /** First boot + enrollment: a fresh device identity and its claim code. */
  const enrolled = async (): Promise<EnrolledHub> => {
    const identity = await createHubIdentity();
    const res = await enroll(identity);
    if (res.status !== 201) fail('enroll', res);
    return {
      identity,
      enrollmentId: res.body.enrollmentId as string,
      claimCode: res.body.claimCode as string,
    };
  };

  return {
    http,
    bearer,
    enrollBody,
    enroll,
    status,
    challenge,
    token,
    authenticate,
    sync,
    syncAll,
    linkCode,
    enrolled,
    waitClaimed,
    /**
     * The whole onboarding over HTTP: the device enrolls, the owner's app claims it by code (`POST /hubs/claim`) and
     * the device learns its hub id from the status.
     */
    onboard: async (ownerToken: string, name = 'Sala'): Promise<ClaimedHub> => {
      const device = await enrolled();
      const res = await http()
        .post('/hubs/claim')
        .set(bearer(ownerToken))
        .send({ claimCode: device.claimCode, name });
      if (res.status !== 201) fail('claim', res);
      return waitClaimed(device);
    },
  };
}

export type HubClient = ReturnType<typeof hubClient>;
