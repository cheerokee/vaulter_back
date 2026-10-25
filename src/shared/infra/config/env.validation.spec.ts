import { validateEnv } from './env.validation.js';

const seed = 'A'.repeat(43);

function validConfig(): Record<string, unknown> {
  return {
    DB_HOST: 'localhost',
    DB_PORT: '5432',
    DB_USERNAME: 'vaulter',
    DB_PASSWORD: 'vaulter',
    DB_DATABASE: 'vaulter',
    DB_APP_USERNAME: 'vaulter_app',
    DB_APP_PASSWORD: 'vaulter_app',
    PROBLEM_TYPE_BASE_URL: 'https://errors.example.invalid',
    API_DOCS_TITLE: 'API',
    AUTH_JWT_ISSUER: 'http://localhost:3000',
    AUTH_JWT_KEY_ID: 'dev-1',
    AUTH_JWT_SIGNING_SEED: seed,
    IDENTITY_DECOY_SALT_KEY: seed,
  };
}

describe('validateEnv', () => {
  it('rejects missing AUTH_JWT_SIGNING_SEED', () => {
    const config = validConfig();
    delete config.AUTH_JWT_SIGNING_SEED;
    expect(() => validateEnv(config)).toThrow(/AUTH_JWT_SIGNING_SEED/);
  });

  it('applies defaults', () => {
    const env = validateEnv(validConfig());
    expect(env.AUTH_ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(env.AUTH_REFRESH_TOKEN_IDLE_DAYS).toBe(30);
    expect(env.API_DOCS_INTERNAL_ENABLED).toBe(false);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('rejects a signing seed that is not 32 bytes of base64url', () => {
    expect(() =>
      validateEnv({ ...validConfig(), AUTH_JWT_SIGNING_SEED: 'short' }),
    ).toThrow(/AUTH_JWT_SIGNING_SEED/);
    expect(() =>
      validateEnv({ ...validConfig(), AUTH_JWT_SIGNING_SEED: 'A'.repeat(44) }),
    ).toThrow(/AUTH_JWT_SIGNING_SEED/);
  });

  it.each(['DB_HOST', 'DB_PORT', 'DB_USERNAME', 'DB_PASSWORD', 'DB_DATABASE'])(
    'rejects missing %s',
    (key) => {
      const config = validConfig();
      delete config[key];
      expect(() => validateEnv(config)).toThrow(new RegExp(key));
    },
  );

  it('rejects a non-integer DB_PORT', () => {
    expect(() => validateEnv({ ...validConfig(), DB_PORT: 'abc' })).toThrow(
      /DB_PORT/,
    );
  });
});
