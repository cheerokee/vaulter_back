import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../setup/test-app.js';

describe('problem details (e2e)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('GET /does-not-exist returns 404 problem+json', async () => {
    const res = await request(app.getHttpServer()).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.type).toMatch(/\/not-found$/);
    expect(res.body.requestId).toBeTruthy();
  });
});
