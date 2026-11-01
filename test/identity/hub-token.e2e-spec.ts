import type { INestApplication } from '@nestjs/common';
import { HubTokenService } from '../../src/identity/application/hub-token-service.js';
import { UnauthenticatedError } from '../../src/shared/domain/errors.js';
import { newId } from '../../src/shared/domain/id.js';
import { createTestApp, resetDatabase } from '../setup/test-app.js';
import { createClientAccount } from '../support/client-crypto.js';
import { identityClient } from '../support/identity-client.js';

// Token de Hub (typ hub+jwt) x token de usuário (typ at+jwt): mesmas chaves, nunca intercambiáveis.
describe('Hub access tokens (e2e)', () => {
  let app: INestApplication;
  const c = identityClient(() => app);

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
  }, 60_000);
  afterAll(async () => {
    await app.close();
  });

  it('a hub token does not pass the user guard; a user token does not pass HubTokenService.verify', async () => {
    const hubs = app.get(HubTokenService);
    const hubId = newId();
    const { token: hubToken } = await hubs.issue(hubId);
    await expect(hubs.verify(hubToken)).resolves.toEqual({ hubId });

    const res = await c.http().get('/me').set(c.bearer(hubToken)).expect(401);
    expect(res.body.type).toMatch(/\/invalid-access-token$/);

    const account = await createClientAccount('correct horse battery staple');
    const reg = await c.register(account, 'hub-token@example.com').expect(201);
    const userToken = reg.body.session.accessToken as string;
    await c.http().get('/me').set(c.bearer(userToken)).expect(200);
    await expect(hubs.verify(userToken)).rejects.toMatchObject({
      constructor: UnauthenticatedError,
      code: 'invalid-hub-token',
    });
  });
});
