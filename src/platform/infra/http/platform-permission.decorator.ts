import { SetMetadata } from '@nestjs/common';
import type { PlatformPermission } from '../../domain/platform-catalog.js';

export const PLATFORM_PERMISSION_KEY = 'platformPermission';
export const PLATFORM_ROUTES_KEY = 'platformRoutes';

/**
 * Marks a controller as /platform/*: the global PlatformPermissionGuard then requires a platform requirement on every
 * handler of it (a handler without one is a programming error: 500, the route never opens).
 */
export const PlatformRoutes = (): ClassDecorator =>
  SetMetadata(PLATFORM_ROUTES_KEY, true);

/** What the PlatformPermissionGuard requires on a route: a permission, or any platform role (`any-role`). */
export type PlatformRequirement = PlatformPermission | 'any-role';

/** The route needs this platform permission (checked in the database on every request; 404 without it). */
export const RequirePlatformPermission = (
  permission: PlatformPermission,
): MethodDecorator =>
  SetMetadata(
    PLATFORM_PERMISSION_KEY,
    permission satisfies PlatformRequirement,
  );

/** The route needs any platform role, even one without permissions (e.g. GET /platform/me for finance). */
export const RequireAnyPlatformRole = (): MethodDecorator =>
  SetMetadata(
    PLATFORM_PERMISSION_KEY,
    'any-role' satisfies PlatformRequirement,
  );
