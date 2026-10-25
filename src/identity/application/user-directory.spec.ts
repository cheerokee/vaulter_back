import type { UserRepository } from '../domain/user.repository.js';
import { User } from '../domain/user.js';
import { UserDirectory } from './user-directory.js';

const b64 = (n: number) => Buffer.alloc(n, 1).toString('base64url');

describe('UserDirectory', () => {
  const users = { findByIds: vi.fn() };
  const dir = new UserDirectory(users as unknown as UserRepository);

  it('returns [] without hitting the repository for empty input', async () => {
    await expect(dir.findPublicByIds([])).resolves.toEqual([]);
    expect(users.findByIds).not.toHaveBeenCalled();
  });

  it('exposes only id, name, email and publicKey', async () => {
    const u = User.register({
      name: 'Ana',
      email: 'ana@x.com',
      authHash: 'SECRET-HASH',
      kdfSalt: b64(16),
      kdfParams: {
        algorithm: 'argon2id13',
        opsLimit: 3,
        memLimitBytes: 67108864,
      },
      publicKey: b64(32),
      encryptedPrivateKey: Buffer.concat([
        Buffer.from([1]),
        Buffer.alloc(72, 2),
      ]).toString('base64url'),
      now: new Date(),
    });
    users.findByIds.mockResolvedValue([u]);
    const out = await dir.findPublicByIds([u.id, u.id]);
    expect(users.findByIds).toHaveBeenCalledWith([u.id]);
    expect(out).toEqual([
      { id: u.id, name: 'Ana', email: 'ana@x.com', publicKey: b64(32) },
    ]);
    expect(JSON.stringify(out)).not.toContain('SECRET');
  });
});
