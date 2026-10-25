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
    AUTH_JWT_AUDIENCE: 'http://localhost:3000',
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

  it('defaults TRUST_PROXY to false and accepts valid values', () => {
    expect(validateEnv(validConfig()).TRUST_PROXY).toBe('false');
    for (const v of ['true', '1', '10.0.0.0/8, 127.0.0.1']) {
      expect(
        validateEnv({ ...validConfig(), TRUST_PROXY: v }).TRUST_PROXY,
      ).toBe(v);
    }
  });

  it('rejects an invalid TRUST_PROXY', () => {
    expect(() =>
      validateEnv({ ...validConfig(), TRUST_PROXY: 'maybe' }),
    ).toThrow(/TRUST_PROXY/);
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

  it('rejects missing or empty AUTH_JWT_AUDIENCE', () => {
    const config = validConfig();
    delete config.AUTH_JWT_AUDIENCE;
    expect(() => validateEnv(config)).toThrow(/AUTH_JWT_AUDIENCE/);
    expect(() =>
      validateEnv({ ...validConfig(), AUTH_JWT_AUDIENCE: '' }),
    ).toThrow(/AUTH_JWT_AUDIENCE/);
  });

  it('accepts absent, empty or well-formed AUTH_JWT_PREVIOUS_KEYS', () => {
    expect(() => validateEnv(validConfig())).not.toThrow();
    expect(() =>
      validateEnv({ ...validConfig(), AUTH_JWT_PREVIOUS_KEYS: '' }),
    ).not.toThrow();
    expect(() =>
      validateEnv({
        ...validConfig(),
        AUTH_JWT_PREVIOUS_KEYS: `old-1:${seed},old-2:${'B'.repeat(42)}A`,
      }),
    ).not.toThrow();
  });

  it.each([
    ['no colon', 'old-1'],
    ['short seed', 'old-1:short'],
    ['empty kid', `:${seed}`],
    ['trailing comma', `old-1:${seed},`],
    ['duplicate kid', `old-1:${seed},old-1:${seed}`],
    ['kid equal to the current key id', `dev-1:${seed}`],
  ])('rejects malformed AUTH_JWT_PREVIOUS_KEYS (%s)', (_name, value) => {
    expect(() =>
      validateEnv({ ...validConfig(), AUTH_JWT_PREVIOUS_KEYS: value }),
    ).toThrow(/AUTH_JWT_PREVIOUS_KEYS/);
  });
});

describe('validateEnv ARGON2_POOL_SIZE', () => {
  it('is optional and treats empty as unset', () => {
    expect(validateEnv(validConfig()).ARGON2_POOL_SIZE).toBeUndefined();
    expect(
      validateEnv({ ...validConfig(), ARGON2_POOL_SIZE: '' }).ARGON2_POOL_SIZE,
    ).toBeUndefined();
  });

  it('accepts an integer >= 1 and rejects the rest', () => {
    expect(
      validateEnv({ ...validConfig(), ARGON2_POOL_SIZE: '3' }).ARGON2_POOL_SIZE,
    ).toBe(3);
    for (const bad of ['0', '-1', '1.5', 'x']) {
      expect(() =>
        validateEnv({ ...validConfig(), ARGON2_POOL_SIZE: bad }),
      ).toThrow(/ARGON2_POOL_SIZE/);
    }
  });
});
