import {
  DB_POOL_CONNECTION_TIMEOUT_MS,
  DB_POOL_MAX_CONNECTIONS,
  typeOrmOptions,
} from './typeorm.options.js';

describe('typeOrmOptions', () => {
  it('sets the pool size and the connection wait explicitly, for both roles', () => {
    expect(DB_POOL_MAX_CONNECTIONS).toBe(10);
    for (const role of ['app', 'migration'] as const) {
      expect(typeOrmOptions(role)).toMatchObject({
        extra: {
          max: DB_POOL_MAX_CONNECTIONS,
          connectionTimeoutMillis: DB_POOL_CONNECTION_TIMEOUT_MS,
        },
      });
    }
  });
});
