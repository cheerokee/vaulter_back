import type { INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { setupSwagger } from '../../src/shared/infra/http/swagger.js';
import { createTestApp } from '../setup/test-app.js';

describe('Swagger documents (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('serves the internal document', async () => {
    await request(app.getHttpServer()).get('/docs/json').expect(200);
  });

  it('serves the internal UI and the public UI separately', async () => {
    const internal = await request(app.getHttpServer())
      .get('/docs')
      .expect(200);
    const pub = await request(app.getHttpServer())
      .get('/docs/public')
      .expect(200);
    expect(internal.text).toContain('swagger');
    expect(pub.text).toContain('swagger');
  });

  it('serves the public document without internal routes', async () => {
    const res = await request(app.getHttpServer())
      .get('/docs/public/json')
      .expect(200);
    const paths = Object.keys(res.body.paths as Record<string, unknown>);
    for (const prefix of ['/auth', '/sessions', '/me']) {
      expect(paths.filter((p) => p.startsWith(prefix))).toEqual([]);
    }
  });
});

// O ConfigModule lê o ambiente uma vez, ao importar o AppModule; por isso aqui
// o setupSwagger roda num app mínimo, com a configuração simulada.
describe('Swagger with the internal document disabled (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({}).compile();
    app = moduleRef.createNestApplication();
    const values: Record<string, unknown> = {
      API_DOCS_TITLE: 'API',
      API_DOCS_INTERNAL_ENABLED: false,
    };
    setupSwagger(app, {
      get: (k: string) => values[k],
      getOrThrow: (k: string) => values[k],
    } as unknown as ConfigService);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('still serves the public document and hides the internal one', async () => {
    await request(app.getHttpServer()).get('/docs/public/json').expect(200);
    await request(app.getHttpServer()).get('/docs/json').expect(404);
    await request(app.getHttpServer()).get('/docs').expect(404);
  });
});
