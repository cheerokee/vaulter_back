import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { NotFoundError } from '../../../shared/domain/errors.js';
import type { PlatformAccess } from '../../application/platform-access.js';
import {
  PlatformRoutes,
  RequirePlatformPermission,
} from './platform-permission.decorator.js';
import { PlatformPermissionGuard } from './platform-permission.guard.js';

class CustomerController {
  handler(this: void) {}
}

@PlatformRoutes()
class PlatformController {
  @RequirePlatformPermission('platform.audit.read')
  guarded(this: void) {}
  forgotten(this: void) {}
}

const access = {
  require: vi.fn(),
  requireAnyRole: vi.fn(),
};
const guard = new PlatformPermissionGuard(
  new Reflector(),
  access as unknown as PlatformAccess,
);

function context(cls: object, handler: () => void, auth?: object) {
  return {
    getClass: () => cls,
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: () => ({ auth, method: 'GET', originalUrl: '/platform/x' }),
    }),
  } as unknown as ExecutionContext;
}

beforeEach(() => vi.clearAllMocks());

describe('PlatformPermissionGuard (global)', () => {
  it('does nothing on a route outside the platform controllers', async () => {
    await expect(
      guard.canActivate(
        context(CustomerController, CustomerController.prototype.handler),
      ),
    ).resolves.toBe(true);
    expect(access.require).not.toHaveBeenCalled();
  });

  it('fails closed on a platform controller handler without a requirement', async () => {
    await expect(
      guard.canActivate(
        context(PlatformController, PlatformController.prototype.forgotten, {
          userId: 'u1',
        }),
      ),
    ).rejects.toThrow(/has no platform requirement/);
  });

  it('answers the unmatched-route 404 without the permission', async () => {
    access.require.mockRejectedValueOnce(
      new NotFoundError('not-found', 'nope'),
    );
    const err = await guard
      .canActivate(
        context(PlatformController, PlatformController.prototype.guarded, {
          userId: 'u1',
        }),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).message).toBe('Cannot GET /platform/x');
    expect(access.require).toHaveBeenCalledWith('u1', 'platform.audit.read');
  });
});
