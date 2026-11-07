import { NotFoundError } from '../../shared/domain/errors.js';
import type { PlatformRoleRepository } from '../domain/platform-role.repository.js';
import { PlatformAccess } from './platform-access.js';

const USER = '019a1b2c-0000-7000-8000-0000000000a1';

const roles = { permissionsOf: vi.fn(), hasAnyRole: vi.fn() };
const access = new PlatformAccess(roles as unknown as PlatformRoleRepository);

beforeEach(() => {
  vi.resetAllMocks();
});

describe('PlatformAccess', () => {
  it('require: without the permission -> 404 not-found (does not reveal the platform routes)', async () => {
    roles.permissionsOf.mockResolvedValue([
      'platform.support.request',
      'platform.audit.read',
    ]);
    const err = await access
      .require(USER, 'platform.roles.manage')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).code).toBe('not-found');
  });

  it('require: someone with no role at all -> 404 not-found', async () => {
    roles.permissionsOf.mockResolvedValue([]);
    await expect(
      access.require(USER, 'platform.audit.read'),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('require: with the permission -> returns every permission of the user, read from the database each time', async () => {
    roles.permissionsOf.mockResolvedValue([
      'platform.support.request',
      'platform.audit.read',
    ]);
    await expect(access.require(USER, 'platform.audit.read')).resolves.toEqual([
      'platform.support.request',
      'platform.audit.read',
    ]);
    await access.require(USER, 'platform.audit.read');
    expect(roles.permissionsOf).toHaveBeenCalledTimes(2);
    expect(roles.permissionsOf).toHaveBeenCalledWith(USER);
  });

  it('has: true/false without throwing', async () => {
    roles.permissionsOf.mockResolvedValue(['platform.audit.read']);
    await expect(access.has(USER, 'platform.audit.read')).resolves.toBe(true);
    await expect(access.has(USER, 'platform.roles.manage')).resolves.toBe(
      false,
    );
  });

  it('requireAnyRole: a role without permissions (finance) passes; no role -> 404 not-found', async () => {
    roles.hasAnyRole.mockResolvedValueOnce(true);
    await expect(access.requireAnyRole(USER)).resolves.toBeUndefined();
    roles.hasAnyRole.mockResolvedValueOnce(false);
    await expect(access.requireAnyRole(USER)).rejects.toMatchObject({
      code: 'not-found',
    });
  });
});
