import {
  createHubIdentity,
  signEnrollment,
  signStatus,
  type HubIdentity,
} from '../../../test/support/hub-crypto.js';
import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
  UnauthenticatedError,
} from '../../shared/domain/errors.js';
import { SodiumHubSignatureVerifier } from '../infra/crypto/sodium-hub-signature-verifier.js';
import { Enrollment, ENROLLMENT_TTL_MS } from '../domain/enrollment.js';
import type { EnrollmentRepository } from '../domain/enrollment.repository.js';
import { Hub } from '../domain/hub.js';
import type { HubRepository } from '../domain/hub.repository.js';
import { EnrollHubUseCase } from './enroll-hub.use-case.js';
import { EnrollmentStatusUseCase } from './enrollment-status.use-case.js';
import type { HubCodeHasher } from './ports/hub-code-hasher.js';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const NONCE = Buffer.alloc(16, 7).toString('base64url');
const iso = (offsetMs: number) =>
  new Date(NOW.getTime() + offsetMs).toISOString();

const enrollments = {
  create: vi.fn(),
  findById: vi.fn(),
  findPendingByCodeHash: vi.fn(),
  lockPendingByCodeHash: vi.fn(),
  markClaimed: vi.fn(),
  expireStale: vi.fn(),
};
const hubs = { findBySigningKey: vi.fn() };
let codeSeq = 0;
const codes = {
  newCode: vi.fn(() => String(12345670 + codeSeq++)),
  hash: vi.fn(async (c: string) => `hash:${c}`),
};
const verifier = new SodiumHubSignatureVerifier();

let hub: HubIdentity;
let other: HubIdentity;
beforeAll(async () => {
  hub = await createHubIdentity();
  other = await createHubIdentity();
});
beforeEach(() => {
  vi.clearAllMocks();
  codeSeq = 0;
  hubs.findBySigningKey.mockResolvedValue(null);
  enrollments.create.mockResolvedValue(undefined);
  enrollments.expireStale.mockResolvedValue(0);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('EnrollHubUseCase', () => {
  const useCase = () =>
    new EnrollHubUseCase(
      enrollments as unknown as EnrollmentRepository,
      hubs as unknown as HubRepository,
      verifier,
      codes as unknown as HubCodeHasher,
    );
  const input = async (
    over: Partial<{
      timestamp: string;
      nonce: string;
      signer: HubIdentity;
    }> = {},
  ) => {
    const timestamp = over.timestamp ?? iso(0);
    const nonce = over.nonce ?? NONCE;
    return {
      signingPublicKey: hub.signingPublicKey,
      encryptionPublicKey: hub.encryptionPublicKey,
      nonce,
      timestamp,
      signature: await signEnrollment(over.signer ?? hub, { nonce, timestamp }),
    };
  };

  it('creates a pending enrollment and returns the code once (only its hash is stored)', async () => {
    const result = await useCase().execute(await input());
    expect(result.claimCode).toMatch(/^[0-9]{8}$/);
    expect(result.expiresAt.getTime() - NOW.getTime()).toBe(ENROLLMENT_TTL_MS);
    const stored = enrollments.create.mock.calls[0]![0] as Enrollment;
    expect(stored.id).toBe(result.enrollmentId);
    expect(stored.claimCodeHash).toBe(`hash:${result.claimCode}`);
    expect(stored.signingPublicKey).toBe(hub.signingPublicKey);
    expect(stored.nonce).toBe(NONCE);
    expect(enrollments.expireStale).toHaveBeenCalledWith(NOW);
  });

  it('accepts a timestamp at the edge of the ±5 min window and refuses one past it', async () => {
    await expect(
      useCase().execute(await input({ timestamp: iso(-5 * 60_000) })),
    ).resolves.toBeDefined();
    await expect(
      useCase().execute(await input({ timestamp: iso(5 * 60_000 + 1) })),
    ).rejects.toMatchObject({
      constructor: DomainValidationError,
      code: 'timestamp-out-of-window',
    });
    await expect(
      useCase().execute(await input({ timestamp: iso(-5 * 60_000 - 1) })),
    ).rejects.toMatchObject({ code: 'timestamp-out-of-window' });
    await expect(
      useCase().execute(await input({ timestamp: '2026-11-01 12:00:00' })),
    ).rejects.toMatchObject({ code: 'timestamp-invalid' });
  });

  it('refuses a malformed nonce or key before touching the database', async () => {
    await expect(
      useCase().execute(await input({ nonce: 'short' })),
    ).rejects.toMatchObject({ code: 'nonce-invalid' });
    await expect(
      useCase().execute({ ...(await input()), signingPublicKey: 'bad' }),
    ).rejects.toMatchObject({ code: 'signing-public-key-invalid' });
    expect(hubs.findBySigningKey).not.toHaveBeenCalled();
    expect(enrollments.create).not.toHaveBeenCalled();
  });

  it('refuses a signature by another key, over other fields or garbage (401)', async () => {
    const bad = {
      constructor: UnauthenticatedError,
      code: 'hub-signature-invalid',
    };
    await expect(
      useCase().execute(await input({ signer: other })),
    ).rejects.toMatchObject(bad);
    const signed = await input();
    await expect(
      useCase().execute({
        ...signed,
        encryptionPublicKey: other.encryptionPublicKey,
      }),
    ).rejects.toMatchObject(bad);
    await expect(
      useCase().execute({ ...signed, signature: 'x' }),
    ).rejects.toMatchObject(bad);
    expect(enrollments.create).not.toHaveBeenCalled();
  });

  it('gives 409 signing-key-in-use when a hub (even a deregistered one) has the key', async () => {
    const existing = Hub.restore(
      {
        ownerUserId: 'u',
        name: 'n',
        signingPublicKey: hub.signingPublicKey,
        encryptionPublicKey: hub.encryptionPublicKey,
        lastSeenAt: null,
        deletedAt: NOW,
      },
      '019a0000-0000-7000-8000-000000000001',
    );
    hubs.findBySigningKey.mockResolvedValue(existing);
    await expect(useCase().execute(await input())).rejects.toMatchObject({
      constructor: ConflictError,
      code: 'signing-key-in-use',
    });
    expect(hubs.findBySigningKey).toHaveBeenCalledWith(hub.signingPublicKey);
    expect(enrollments.create).not.toHaveBeenCalled();
  });

  it('passes a replayed nonce up as 409 nonce-reused', async () => {
    enrollments.create.mockRejectedValue(
      new ConflictError('nonce-reused', 'used'),
    );
    await expect(useCase().execute(await input())).rejects.toMatchObject({
      code: 'nonce-reused',
    });
    expect(enrollments.create).toHaveBeenCalledTimes(1);
  });

  it('draws a new code when the hash collides with a pending one, and gives up after 5 tries', async () => {
    enrollments.create.mockRejectedValueOnce(
      new ConflictError('claim-code-collision', 'c'),
    );
    const result = await useCase().execute(await input());
    expect(result.claimCode).toBe('12345671');
    expect(enrollments.create).toHaveBeenCalledTimes(2);

    enrollments.create.mockReset();
    enrollments.create.mockRejectedValue(
      new ConflictError('claim-code-collision', 'c'),
    );
    await expect(useCase().execute(await input())).rejects.toMatchObject({
      code: 'claim-code-collision',
    });
    expect(enrollments.create).toHaveBeenCalledTimes(5);
  });
});

describe('EnrollmentStatusUseCase', () => {
  const ENROLLMENT_ID = '019a0000-0000-7000-8000-0000000000e1';
  const HUB_ID = '019a0000-0000-7000-8000-0000000000f1';
  const useCase = () =>
    new EnrollmentStatusUseCase(
      enrollments as unknown as EnrollmentRepository,
      verifier,
    );
  const enrollment = (
    over: Partial<{
      status: 'pending' | 'claimed' | 'expired';
      expiresAt: Date;
    }> = {},
  ) =>
    Enrollment.restore(
      {
        signingPublicKey: hub.signingPublicKey,
        encryptionPublicKey: hub.encryptionPublicKey,
        nonce: NONCE,
        claimCodeHash: 'h',
        expiresAt: over.expiresAt ?? new Date(NOW.getTime() + 60_000),
        status: over.status ?? 'pending',
        claimedHubId: over.status === 'claimed' ? HUB_ID : null,
      },
      ENROLLMENT_ID,
    );
  const ask = async (
    over: Partial<{
      timestamp: string;
      signer: HubIdentity;
      enrollmentId: string;
    }> = {},
  ) => {
    const timestamp = over.timestamp ?? iso(0);
    const enrollmentId = over.enrollmentId ?? ENROLLMENT_ID;
    return useCase().execute({
      enrollmentId,
      timestamp,
      signature: await signStatus(over.signer ?? hub, {
        enrollmentId,
        timestamp,
      }),
    });
  };

  it('reports pending, expired (by status or by time) and claimed with the hub id', async () => {
    enrollments.findById.mockResolvedValue(enrollment());
    await expect(ask()).resolves.toEqual({ status: 'pending' });
    enrollments.findById.mockResolvedValue(enrollment({ expiresAt: NOW }));
    await expect(ask()).resolves.toEqual({ status: 'expired' });
    enrollments.findById.mockResolvedValue(enrollment({ status: 'expired' }));
    await expect(ask()).resolves.toEqual({ status: 'expired' });
    enrollments.findById.mockResolvedValue(enrollment({ status: 'claimed' }));
    await expect(ask()).resolves.toEqual({ status: 'claimed', hubId: HUB_ID });
  });

  it('gives the same 404 for a bad signature, an unknown enrollment and a malformed id', async () => {
    const notFound = {
      constructor: NotFoundError,
      code: 'enrollment-not-found',
    };
    enrollments.findById.mockResolvedValue(enrollment({ status: 'claimed' }));
    await expect(ask({ signer: other })).rejects.toMatchObject(notFound);
    enrollments.findById.mockResolvedValue(null);
    await expect(ask()).rejects.toMatchObject(notFound);
    await expect(ask({ enrollmentId: 'nope' })).rejects.toMatchObject(notFound);
  });

  it('refuses a stale timestamp before looking anything up', async () => {
    await expect(ask({ timestamp: iso(-6 * 60_000) })).rejects.toMatchObject({
      constructor: DomainValidationError,
      code: 'timestamp-out-of-window',
    });
    expect(enrollments.findById).not.toHaveBeenCalled();
  });
});
