import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { isUuidV7 } from '../../src/shared/domain/id.js';
import { createTestApp } from '../setup/test-app.js';

describe('request id', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('echoes a valid X-Request-Id in header and problem body', async () => {
    const res = await request(app.getHttpServer())
      .get('/does-not-exist')
      .set('X-Request-Id', 'abc-123')
      .expect(404);
    expect(res.headers['x-request-id']).toBe('abc-123');
    expect(res.body.requestId).toBe('abc-123');
  });

  it('generates a v7 id when the incoming one is invalid', async () => {
    const res = await request(app.getHttpServer())
      .get('/does-not-exist')
      .set('X-Request-Id', 'bad id!')
      .expect(404);
    expect(isUuidV7(res.headers['x-request-id'] as string)).toBe(true);
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });
});
