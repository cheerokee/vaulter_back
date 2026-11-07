import { NotFoundError } from '../../shared/domain/errors.js';
import { ListPlatformAuditUseCase } from './list-platform-audit.use-case.js';
import {
  LookupHubUseCase,
  LookupOrganizationUseCase,
  LookupUserUseCase,
} from './lookup.use-cases.js';
import type { PlatformAudit } from './platform-audit.js';
import type { HubAdministration } from '../../hubs/application/hub-administration.js';
import type { OrganizationAdministration } from '../../organizations/application/organization-administration.js';
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

const record = vi.fn();
const audit = { record } as unknown as PlatformAudit;
beforeEach(() => vi.clearAllMocks());

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
      audit,
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
        audit,
      ).execute('me', 'x@y.z'),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      new LookupUserUseCase(accessWith([]), users, audit).execute(
        'me',
        'x@y.z',
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('lookup audit (LGPD trail of staff browsing customer data)', () => {
  const support = accessWith(['platform.support.request']);

  it('a found account: who looked and the found user id, never the e-mail', async () => {
    const users = {
      findPublicByEmail: vi.fn(async () => ({
        id: 'u1',
        name: 'N',
        email: 'a@b.c',
      })),
    } as unknown as UserDirectory;
    await new LookupUserUseCase(support, users, audit).execute('me', 'a@b.c');
    expect(record).toHaveBeenCalledWith({
      userId: 'me',
      action: 'platform.lookup.user',
      result: 'success',
      targetUserId: 'u1',
      metadata: { found: true },
    });
  });

  it('a miss: only a flag (the e-mail searched is not stored)', async () => {
    const users = {
      findPublicByEmail: vi.fn(async () => null),
    } as unknown as UserDirectory;
    await expect(
      new LookupUserUseCase(support, users, audit).execute('me', 'x@y.z'),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(record).toHaveBeenCalledWith({
      userId: 'me',
      action: 'platform.lookup.user',
      result: 'success',
      metadata: { found: false },
    });
    expect(JSON.stringify(record.mock.calls)).not.toContain('x@y.z');
  });

  it('hub and organization: the target id when found, the searched id in metadata when not', async () => {
    const hubs = {
      summary: vi.fn(async (id: string) =>
        id === 'h1' ? { hubId: 'h1' } : null,
      ),
    } as unknown as HubAdministration;
    const orgs = {
      summary: vi.fn(async (id: string) =>
        id === 'o1' ? { organizationId: 'o1' } : null,
      ),
    } as unknown as OrganizationAdministration;
    await new LookupHubUseCase(support, hubs, audit).execute('me', 'h1');
    await expect(
      new LookupHubUseCase(support, hubs, audit).execute('me', 'h2'),
    ).rejects.toBeInstanceOf(NotFoundError);
    await new LookupOrganizationUseCase(support, orgs, audit).execute(
      'me',
      'o1',
    );
    await expect(
      new LookupOrganizationUseCase(support, orgs, audit).execute('me', 'o2'),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(record.mock.calls.map(([e]) => e)).toEqual([
      {
        userId: 'me',
        action: 'platform.lookup.hub',
        result: 'success',
        targetHubId: 'h1',
        metadata: { found: true },
      },
      {
        userId: 'me',
        action: 'platform.lookup.hub',
        result: 'success',
        metadata: { found: false, hubId: 'h2' },
      },
      {
        userId: 'me',
        action: 'platform.lookup.organization',
        result: 'success',
        targetOrganizationId: 'o1',
        metadata: { found: true },
      },
      {
        userId: 'me',
        action: 'platform.lookup.organization',
        result: 'success',
        metadata: { found: false, organizationId: 'o2' },
      },
    ]);
  });

  it('without the permission: 404 and nothing audited', async () => {
    const users = {
      findPublicByEmail: vi.fn(),
    } as unknown as UserDirectory;
    await expect(
      new LookupUserUseCase(accessWith([]), users, audit).execute(
        'me',
        'a@b.c',
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(record).not.toHaveBeenCalled();
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
