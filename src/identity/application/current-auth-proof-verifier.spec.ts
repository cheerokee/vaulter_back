import {
  DomainValidationError,
  UnauthenticatedError,
} from '../../shared/domain/errors.js';
import type { UserRepository } from '../domain/user.repository.js';
import { CurrentAuthProofVerifier } from './current-auth-proof-verifier.js';
import type { AuthProofHasher } from './ports/auth-proof-hasher.js';

const proof = Buffer.alloc(32, 7).toString('base64url');

describe('CurrentAuthProofVerifier', () => {
  const users = { findById: vi.fn() };
  const hasher = { verify: vi.fn(), verifyAgainstDummy: vi.fn() };
  const verifier = new CurrentAuthProofVerifier(
    users as unknown as UserRepository,
    hasher as unknown as AuthProofHasher,
  );
  beforeEach(() => {
    vi.resetAllMocks();
    users.findById.mockResolvedValue({ authHash: 'h' });
  });

  it('resolves for the right proof', async () => {
    hasher.verify.mockResolvedValue(true);
    await expect(verifier.verify('u1', proof)).resolves.toBeUndefined();
    expect(hasher.verify).toHaveBeenCalledWith('h', proof);
  });

  it('rejects a wrong proof', async () => {
    hasher.verify.mockResolvedValue(false);
    await expect(verifier.verify('u1', proof)).rejects.toMatchObject({
      code: 'current-auth-proof-invalid',
    });
  });

  it('rejects a malformed proof after verifying against the dummy', async () => {
    await expect(verifier.verify('u1', 'short')).rejects.toBeInstanceOf(
      DomainValidationError,
    );
    expect(hasher.verifyAgainstDummy).toHaveBeenCalledWith('short');
    expect(hasher.verify).not.toHaveBeenCalled();
  });

  it('rejects a missing user as unauthenticated', async () => {
    users.findById.mockResolvedValue(null);
    await expect(verifier.verify('u1', proof)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });
});
