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
    HUB_CODE_HASH_KEY: seed,
    IDENTITY_RECOVERY_HASH_KEY: seed,
    AWS_REGION: 'us-east-1',
    S3_BUCKET_HUB_BRAIN: 'hub-brain',
    CLOUD_KMS_KEY_ID: 'alias/cloud-server-key',
  };
}

describe('validateEnv', () => {
  it('rejects missing or malformed HUB_CODE_HASH_KEY', () => {
    const config = validConfig();
    delete config.HUB_CODE_HASH_KEY;
    expect(() => validateEnv(config)).toThrow(/HUB_CODE_HASH_KEY/);
    expect(() =>
      validateEnv({ ...validConfig(), HUB_CODE_HASH_KEY: 'short' }),
    ).toThrow(/HUB_CODE_HASH_KEY/);
  });

  it('rejects missing or malformed IDENTITY_RECOVERY_HASH_KEY', () => {
    const config = validConfig();
    delete config.IDENTITY_RECOVERY_HASH_KEY;
    expect(() => validateEnv(config)).toThrow(/IDENTITY_RECOVERY_HASH_KEY/);
    expect(() =>
      validateEnv({
        ...validConfig(),
        IDENTITY_RECOVERY_HASH_KEY: 'A'.repeat(42),
      }),
    ).toThrow(/IDENTITY_RECOVERY_HASH_KEY/);
  });

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

  it('defaults RATE_LIMIT_ENABLED to true and parses false', () => {
    expect(validateEnv(validConfig()).RATE_LIMIT_ENABLED).toBe(true);
    expect(
      validateEnv({ ...validConfig(), RATE_LIMIT_ENABLED: 'false' })
        .RATE_LIMIT_ENABLED,
    ).toBe(false);
    expect(() =>
      validateEnv({ ...validConfig(), RATE_LIMIT_ENABLED: 'nope' }),
    ).toThrow(/RATE_LIMIT_ENABLED/);
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

describe('validateEnv S3', () => {
  it.each(['AWS_REGION', 'S3_BUCKET_HUB_BRAIN'])(
    'rejects missing %s',
    (key) => {
      const config = validConfig();
      delete config[key];
      expect(() => validateEnv(config)).toThrow(new RegExp(key));
      expect(() => validateEnv({ ...validConfig(), [key]: '' })).toThrow(
        new RegExp(key),
      );
    },
  );

  it('defaults S3_FORCE_PATH_STYLE to false and parses true', () => {
    expect(validateEnv(validConfig()).S3_FORCE_PATH_STYLE).toBe(false);
    expect(
      validateEnv({ ...validConfig(), S3_FORCE_PATH_STYLE: 'true' })
        .S3_FORCE_PATH_STYLE,
    ).toBe(true);
    expect(() =>
      validateEnv({ ...validConfig(), S3_FORCE_PATH_STYLE: 'yes' }),
    ).toThrow(/S3_FORCE_PATH_STYLE/);
  });

  it('treats AWS_ENDPOINT_URL as optional (empty = unset) and rejects a non-URL', () => {
    expect(validateEnv(validConfig()).AWS_ENDPOINT_URL).toBeUndefined();
    expect(
      validateEnv({ ...validConfig(), AWS_ENDPOINT_URL: '' }).AWS_ENDPOINT_URL,
    ).toBeUndefined();
    expect(
      validateEnv({ ...validConfig(), AWS_ENDPOINT_URL: 'http://aws:4566' })
        .AWS_ENDPOINT_URL,
    ).toBe('http://aws:4566');
    expect(() =>
      validateEnv({ ...validConfig(), AWS_ENDPOINT_URL: 'not a url' }),
    ).toThrow(/AWS_ENDPOINT_URL/);
  });

  it('accepts no static credentials (IAM role) or both, never only one', () => {
    expect(() => validateEnv(validConfig())).not.toThrow();
    expect(() =>
      validateEnv({
        ...validConfig(),
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
      }),
    ).not.toThrow();
    expect(() =>
      validateEnv({ ...validConfig(), AWS_ACCESS_KEY_ID: 'test' }),
    ).toThrow(/AWS_SECRET_ACCESS_KEY/);
    expect(() =>
      validateEnv({ ...validConfig(), AWS_SECRET_ACCESS_KEY: 'test' }),
    ).toThrow(/AWS_ACCESS_KEY_ID/);
  });
});

describe('validateEnv cloud and jobs', () => {
  it('defaults the embedding and language model settings and validates the driver', () => {
    const env = validateEnv(validConfig());
    expect(env.EMBEDDINGS_URL).toBe('http://embeddings:11434');
    expect(env.EMBEDDING_MODEL).toBe('nomic-embed-text:v1.5');
    expect(env.CLOUD_LLM_DRIVER).toBe('bedrock');
    expect(() =>
      validateEnv({ ...validConfig(), CLOUD_LLM_DRIVER: 'openai' }),
    ).toThrow(/CLOUD_LLM_DRIVER/);
  });

  it('refuses the fake language model driver in production only', () => {
    const base = { ...validConfig(), CLOUD_LLM_DRIVER: 'fake' };
    expect(() => validateEnv({ ...base, NODE_ENV: 'production' })).toThrow(
      /CLOUD_LLM_DRIVER/,
    );
    expect(
      validateEnv({ ...base, NODE_ENV: 'development' }).CLOUD_LLM_DRIVER,
    ).toBe('fake');
  });

  it('requires CLOUD_KMS_KEY_ID', () => {
    const config = validConfig();
    delete config.CLOUD_KMS_KEY_ID;
    expect(() => validateEnv(config)).toThrow(/CLOUD_KMS_KEY_ID/);
    expect(() =>
      validateEnv({ ...validConfig(), CLOUD_KMS_KEY_ID: '' }),
    ).toThrow(/CLOUD_KMS_KEY_ID/);
  });

  it('defaults JOB_WORKERS_ENABLED to true and parses false', () => {
    expect(validateEnv(validConfig()).JOB_WORKERS_ENABLED).toBe(true);
    expect(
      validateEnv({ ...validConfig(), JOB_WORKERS_ENABLED: 'false' })
        .JOB_WORKERS_ENABLED,
    ).toBe(false);
    expect(() =>
      validateEnv({ ...validConfig(), JOB_WORKERS_ENABLED: 'no' }),
    ).toThrow(/JOB_WORKERS_ENABLED/);
  });
});
