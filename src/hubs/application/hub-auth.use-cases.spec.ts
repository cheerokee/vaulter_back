import {
  createHubIdentity,
  signAuth,
  type HubIdentity,
} from '../../../test/support/hub-crypto.js';
import type { HubTokenService } from '../../identity/application/hub-token-service.js';
import { UnauthenticatedError } from '../../shared/domain/errors.js';
import type { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { SodiumHubSignatureVerifier } from '../infra/crypto/sodium-hub-signature-verifier.js';
import type {
  AuthChallenge,
  AuthChallengeRepository,
} from '../domain/auth-challenge.repository.js';
import { Hub } from '../domain/hub.js';
import type { HubRepository } from '../domain/hub.repository.js';
import { AuthenticateHubTokenUseCase } from './authenticate-hub-token.use-case.js';
import {
  HUB_CHALLENGE_TTL_MS,
  IssueHubChallengeUseCase,
} from './issue-hub-challenge.use-case.js';
import { IssueHubTokenUseCase } from './issue-hub-token.use-case.js';
import type { HubCodeHasher } from './ports/hub-code-hasher.js';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const HUB_ID = '019a0000-0000-7000-8000-0000000000f1';
const UNKNOWN = '019a0000-0000-7000-8000-0000000000f2';
const CHALLENGE = Buffer.alloc(32, 9).toString('base64url');
const FAILED = { constructor: UnauthenticatedError, code: 'hub-auth-failed' };

let identity: HubIdentity;
let other: HubIdentity;
beforeAll(async () => {
  identity = await createHubIdentity();
  other = await createHubIdentity();
});

const makeHub = (deletedAt: Date | null = null) =>
  Hub.restore(
    {
      ownerUserId: '019a0000-0000-7000-8000-0000000000a1',
      name: 'Sala',
      signingPublicKey: identity.signingPublicKey,
      encryptionPublicKey: identity.encryptionPublicKey,
      lastSeenAt: null,
      deletedAt,
    },
    HUB_ID,
  );

const calls: string[] = [];
let inTx = false;
const hubs = { findById: vi.fn(), save: vi.fn() };
const challenges = { create: vi.fn(), consume: vi.fn() };
const codes = {
  newChallenge: vi.fn(() => CHALLENGE),
  hashChallenge: vi.fn(async (c: string) => `ch:${c}`),
};
const tokens = { issue: vi.fn(), verify: vi.fn() };
const uow = {
  run: vi.fn(async (work: () => Promise<unknown>) => {
    inTx = true;
    try {
      return await work();
    } finally {
      inTx = false;
    }
  }),
  setContext: vi.fn(async (ctx: unknown) => {
    calls.push(`ctx:${JSON.stringify(ctx)}`);
  }),
  withContext: vi.fn(async (ctx: unknown, work: () => Promise<unknown>) => {
    calls.push(`with:${JSON.stringify(ctx)}`);
    return work();
  }),
};
const verifier = new SodiumHubSignatureVerifier();

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  hubs.findById.mockImplementation(async (id: string) =>
    id === HUB_ID ? makeHub() : null,
  );
  hubs.save.mockImplementation(async () => {
    calls.push(`save:${String(inTx)}`);
  });
  challenges.consume.mockImplementation(async (): Promise<AuthChallenge> => {
    calls.push(`consume:${String(inTx)}`);
    return {
      id: 'c1',
      hubId: HUB_ID,
      challengeHash: `ch:${CHALLENGE}`,
      expiresAt: NOW,
      usedAt: NOW,
    };
  });
  tokens.issue.mockResolvedValue({ token: 'jwt', expiresAt: NOW });
});
afterEach(() => vi.useRealTimers());

describe('IssueHubChallengeUseCase', () => {
  const useCase = () =>
    new IssueHubChallengeUseCase(
      hubs as unknown as HubRepository,
      challenges as unknown as AuthChallengeRepository,
      codes as unknown as HubCodeHasher,
      uow as unknown as UnitOfWork,
    );

  it('stores the hash of a 60 s challenge bound to an active hub, read in the hub context', async () => {
    const result = await useCase().execute(HUB_ID);
    expect(result).toEqual({
      challenge: CHALLENGE,
      expiresAt: new Date(NOW.getTime() + HUB_CHALLENGE_TTL_MS),
    });
    expect(HUB_CHALLENGE_TTL_MS).toBe(60_000);
    expect(calls).toEqual([`ctx:${JSON.stringify({ hubId: HUB_ID })}`]);
    expect(challenges.create).toHaveBeenCalledWith(
      expect.objectContaining({
        hubId: HUB_ID,
        challengeHash: `ch:${CHALLENGE}`,
        expiresAt: result.expiresAt,
        usedAt: null,
      }),
    );
    expect(JSON.stringify(challenges.create.mock.calls)).not.toContain(
      `"${CHALLENGE}"`,
    );
  });

  it('gives an indistinguishable decoy (hub_id null) for an unknown, deregistered or malformed hub', async () => {
    const real = await useCase().execute(HUB_ID);
    const unknown = await useCase().execute(UNKNOWN);
    hubs.findById.mockResolvedValueOnce(makeHub(NOW));
    const deregistered = await useCase().execute(HUB_ID);
    const malformed = await useCase().execute('nope');
    for (const decoy of [unknown, deregistered, malformed]) {
      expect(Object.keys(decoy)).toEqual(Object.keys(real));
      expect(decoy.expiresAt).toEqual(real.expiresAt);
      expect(decoy.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    const stored = challenges.create.mock.calls.map(
      (c) => (c[0] as AuthChallenge).hubId,
    );
    expect(stored).toEqual([HUB_ID, null, null, null]);
    // Id malformado nunca vira contexto (o cast para uuid falharia no banco).
    expect(hubs.findById).not.toHaveBeenCalledWith('nope');
  });
});

describe('IssueHubTokenUseCase', () => {
  const useCase = () =>
    new IssueHubTokenUseCase(
      hubs as unknown as HubRepository,
      challenges as unknown as AuthChallengeRepository,
      verifier,
      codes as unknown as HubCodeHasher,
      tokens as unknown as HubTokenService,
      uow as unknown as UnitOfWork,
    );
  const request = async (
    over: Partial<{
      hubId: string;
      challenge: string;
      signer: HubIdentity;
    }> = {},
  ) => {
    const hubId = over.hubId ?? HUB_ID;
    const challenge = over.challenge ?? CHALLENGE;
    return {
      hubId,
      challenge,
      signature: await signAuth(over.signer ?? identity, { hubId, challenge }),
    };
  };

  it('verifies, consumes the challenge, touches last_seen_at and issues the hub token', async () => {
    await expect(useCase().execute(await request())).resolves.toEqual({
      token: 'jwt',
      expiresAt: NOW,
    });
    expect(calls).toEqual([
      `ctx:${JSON.stringify({ hubId: HUB_ID })}`,
      'consume:true',
      'save:true',
    ]);
    expect(challenges.consume).toHaveBeenCalledWith(
      HUB_ID,
      `ch:${CHALLENGE}`,
      NOW,
    );
    expect((hubs.save.mock.calls[0]![0] as Hub).lastSeenAt).toEqual(NOW);
    expect(tokens.issue).toHaveBeenCalledWith(HUB_ID, NOW);
  });

  it('verifies an unknown or deregistered hub against the shared random decoy key', async () => {
    const spy = vi.spyOn(verifier, 'verify');
    try {
      await expect(
        useCase().execute(await request({ hubId: UNKNOWN })),
      ).rejects.toMatchObject(FAILED);
      hubs.findById.mockResolvedValueOnce(makeHub(NOW));
      await expect(useCase().execute(await request())).rejects.toMatchObject(
        FAILED,
      );
      const keys = spy.mock.calls.map((c) => c[3]);
      expect(keys).toEqual([
        verifier.decoyPublicKey(),
        verifier.decoyPublicKey(),
      ]);
      expect(verifier.decoyPublicKey()).not.toBe('A'.repeat(43));
    } finally {
      spy.mockRestore();
    }
  });

  it('gives the same 401 for an unknown hub, a deregistered hub, a wrong signer and a used challenge', async () => {
    await expect(
      useCase().execute(await request({ hubId: UNKNOWN })),
    ).rejects.toMatchObject(FAILED);
    hubs.findById.mockResolvedValueOnce(makeHub(NOW));
    await expect(useCase().execute(await request())).rejects.toMatchObject(
      FAILED,
    );
    await expect(
      useCase().execute(await request({ signer: other })),
    ).rejects.toMatchObject(FAILED);
    challenges.consume.mockResolvedValueOnce(null);
    await expect(useCase().execute(await request())).rejects.toMatchObject(
      FAILED,
    );
    expect(hubs.save).not.toHaveBeenCalled();
    expect(tokens.issue).not.toHaveBeenCalled();
  });

  it('does not burn the challenge on a bad signature', async () => {
    await expect(
      useCase().execute(await request({ signer: other })),
    ).rejects.toMatchObject(FAILED);
    expect(challenges.consume).not.toHaveBeenCalled();
  });

  it('refuses a signature over another hub id (no cross-hub replay)', async () => {
    const signedForOther = await request({ hubId: UNKNOWN });
    await expect(
      useCase().execute({ ...signedForOther, hubId: HUB_ID }),
    ).rejects.toMatchObject(FAILED);
  });

  it('refuses malformed input with the same 401, without touching the database', async () => {
    await expect(
      useCase().execute(await request({ hubId: 'nope' })),
    ).rejects.toMatchObject(FAILED);
    await expect(
      useCase().execute(await request({ challenge: 'short' })),
    ).rejects.toMatchObject(FAILED);
    expect(uow.run).not.toHaveBeenCalled();
  });
});

describe('AuthenticateHubTokenUseCase', () => {
  const useCase = () =>
    new AuthenticateHubTokenUseCase(
      tokens as unknown as HubTokenService,
      hubs as unknown as HubRepository,
      uow as unknown as UnitOfWork,
    );
  const INVALID = {
    constructor: UnauthenticatedError,
    code: 'invalid-hub-token',
  };

  it('accepts a valid token of an active hub, reading it in the hub context', async () => {
    tokens.verify.mockResolvedValue({ hubId: HUB_ID });
    await expect(useCase().execute('t', NOW)).resolves.toEqual({
      hubId: HUB_ID,
    });
    expect(tokens.verify).toHaveBeenCalledWith('t', NOW);
    expect(calls).toEqual([`with:${JSON.stringify({ hubId: HUB_ID })}`]);
  });

  it('refuses a deregistered or missing hub with invalid-hub-token', async () => {
    tokens.verify.mockResolvedValue({ hubId: HUB_ID });
    hubs.findById.mockResolvedValueOnce(makeHub(NOW));
    await expect(useCase().execute('t', NOW)).rejects.toMatchObject(INVALID);
    tokens.verify.mockResolvedValue({ hubId: UNKNOWN });
    await expect(useCase().execute('t', NOW)).rejects.toMatchObject(INVALID);
  });

  it('passes the token failure through (a user token fails verify)', async () => {
    tokens.verify.mockRejectedValue(
      new UnauthenticatedError('invalid-hub-token', 'x'),
    );
    await expect(useCase().execute('t', NOW)).rejects.toMatchObject(INVALID);
    expect(hubs.findById).not.toHaveBeenCalled();
  });
});
