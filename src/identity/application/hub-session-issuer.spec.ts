import { UnauthenticatedError } from '../../shared/domain/errors.js';
import type { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { User } from '../domain/user.js';
import type { CredentialCheck } from './credential-check.js';
import { HubSessionIssuer } from './hub-session-issuer.js';
import type { SessionIssuer } from './session-issuer.js';

const b64 = (n: number, fill = 1) =>
  Buffer.alloc(n, fill).toString('base64url');
const epk = Buffer.alloc(73, 2);
epk[0] = 1;
const PROOF = b64(32, 9);
const HUB = '01a1c1c7-d97a-7596-9dc8-07988c27a845';

const user = User.register({
  name: 'Ana',
  email: 'ana@x.com',
  authHash: 'stored-hash',
  kdfSalt: b64(16),
  kdfParams: { algorithm: 'argon2id13', opsLimit: 3, memLimitBytes: 67108864 },
  publicKey: b64(32),
  encryptedPrivateKey: epk.toString('base64url'),
  recoveryHash: 'recovery-hash',
  recoveryEncryptedPrivateKey: epk.toString('base64url'),
  now: new Date('2026-10-24T11:00:00Z'),
});
const client = { ip: null, userAgent: null };

describe('HubSessionIssuer', () => {
  const credentials = { verify: vi.fn() };
  const issuer = { start: vi.fn() };
  const inTx = { value: false };
  const uow = {
    run: vi.fn(async (work: () => Promise<unknown>) => {
      inTx.value = true;
      try {
        return await work();
      } finally {
        inTx.value = false;
      }
    }),
  };
  const useCase = new HubSessionIssuer(
    credentials as unknown as CredentialCheck,
    issuer as unknown as SessionIssuer,
    uow as unknown as UnitOfWork,
  );
  const tokens = {
    sessionId: 's',
    accessToken: 'a',
    accessTokenExpiresAt: new Date(),
    refreshToken: 'r',
    refreshTokenExpiresAt: new Date(),
  };
  const invalid = {
    constructor: UnauthenticatedError,
    code: 'invalid-credentials',
  };
  const login = (isAllowed: (userId: string) => Promise<boolean>) =>
    useCase.loginOnHub({
      hubId: HUB,
      email: 'ana@x.com',
      authProof: PROOF,
      device: { name: 'Sala' },
      client,
      isAllowed,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    issuer.start.mockResolvedValue(tokens);
  });

  it('opens a hub-bound session for a person with a role, checking it inside the transaction', async () => {
    credentials.verify.mockResolvedValue(user);
    const isAllowed = vi.fn(async () => inTx.value);
    const out = await login(isAllowed);
    expect(isAllowed).toHaveBeenCalledWith(user.id);
    expect(issuer.start).toHaveBeenCalledWith(
      user,
      { name: 'Sala', platform: 'hub' },
      client,
      expect.any(Date),
      HUB,
    );
    expect(out.session).toBe(tokens);
  });

  it('no role on the hub: invalid-credentials, no session', async () => {
    credentials.verify.mockResolvedValue(user);
    await expect(login(async () => false)).rejects.toMatchObject(invalid);
    expect(issuer.start).not.toHaveBeenCalled();
  });

  it('wrong password: the same error, and the role check still runs (with an id that is not the user)', async () => {
    credentials.verify.mockResolvedValue(null);
    const isAllowed = vi.fn(async () => true);
    await expect(login(isAllowed)).rejects.toMatchObject(invalid);
    expect(isAllowed).toHaveBeenCalledTimes(1);
    expect(isAllowed).not.toHaveBeenCalledWith(user.id);
    expect(issuer.start).not.toHaveBeenCalled();
  });
});
