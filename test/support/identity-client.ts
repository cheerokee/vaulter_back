import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { ClientAccount } from './client-crypto.js';

export const DEFAULT_DEVICE = { name: 'Pixel 9', platform: 'android' };

/** HTTP helpers for the auth endpoints, shared by the identity e2e specs. */
export function identityClient(getApp: () => INestApplication) {
  const http = () => request(getApp().getHttpServer());

  const registerBody = (
    account: ClientAccount,
    email: string,
    over: Record<string, unknown> = {},
  ) => ({
    name: 'Ana',
    email,
    authProof: account.authProof,
    kdfSalt: account.kdfSalt,
    kdfParams: account.kdfParams,
    publicKey: account.publicKey,
    encryptedPrivateKey: account.encryptedPrivateKey,
    device: DEFAULT_DEVICE,
    ...over,
  });

  return {
    http,
    registerBody,
    register: (
      account: ClientAccount,
      email: string,
      over: Record<string, unknown> = {},
    ) =>
      http()
        .post('/auth/register')
        .send(registerBody(account, email, over)),
    login: (
      email: string,
      authProof: string,
      device: { name: string; platform: string } = DEFAULT_DEVICE,
    ) => http().post('/auth/login').send({ email, authProof, device }),
    bearer: (token: string) => ({ Authorization: `Bearer ${token}` }),
  };
}
