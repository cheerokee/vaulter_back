import { NotFoundError } from '../../shared/domain/errors.js';
import { ListPlatformAuditUseCase } from './list-platform-audit.use-case.js';
import { LookupUserUseCase } from './lookup.use-cases.js';
import { PlatformAccess, platformNotFound } from './platform-access.js';
import type { PlatformAuditLogRepository } from '../domain/platform-audit-log.repository.js';
import type { UserDirectory } from '../../identity/application/user-directory.js';

const accessWith = (permissions: string[]) =>
  ({
    require: vi.fn(async (_u: string, p: string) => {
      if (!permissions.includes(p)) throw platformNotFound();
      return permissions;
    }),
  }) as unknown as PlatformAccess;

describe('lookup use cases', () => {
  it('returns the account without the public key', async () => {
    const users = {
      findPublicByEmail: vi.fn(async () => ({
        id: 'u1',
        name: 'N',
        email: 'a@b.c',
        publicKey: 'pk',
      })),
    } as unknown as UserDirectory;
    const uc = new LookupUserUseCase(
      accessWith(['platform.support.request']),
      users,
    );
    expect(await uc.execute('me', 'A@B.c')).toEqual({
      userId: 'u1',
      name: 'N',
      email: 'a@b.c',
    });
  });

  it('404 for an unknown account and for missing permission', async () => {
    const users = {
      findPublicByEmail: vi.fn(async () => null),
    } as unknown as UserDirectory;
    await expect(
      new LookupUserUseCase(
        accessWith(['platform.support.request']),
        users,
      ).execute('me', 'x@y.z'),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      new LookupUserUseCase(accessWith([]), users).execute('me', 'x@y.z'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('ListPlatformAuditUseCase', () => {
  const repo = () => {
    const list = vi.fn(async () => ({ items: [], nextCursor: null }));
    return { list, repo: { list } as unknown as PlatformAuditLogRepository };
  };

  it('restricts staff without support.approve to their own requests', async () => {
    const { list, repo: r } = repo();
    await new ListPlatformAuditUseCase(
      accessWith(['platform.audit.read']),
      r,
    ).execute({ userId: 'me' } as never, { limit: 5 });
    expect(list).toHaveBeenCalledWith(
      { requestedBy: 'me' },
      { cursor: undefined, limit: 5 },
    );
  });

  it('does not restrict whoever has support.approve', async () => {
    const { list, repo: r } = repo();
    await new ListPlatformAuditUseCase(
      accessWith(['platform.audit.read', 'platform.support.approve']),
      r,
    ).execute({ userId: 'me' } as never, { limit: 5, supportRequestId: 's' });
    expect(list).toHaveBeenCalledWith(
      { supportRequestId: 's' },
      { cursor: undefined, limit: 5 },
    );
  });
});
