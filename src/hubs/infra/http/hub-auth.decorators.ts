import {
  applyDecorators,
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import { Public } from '../../../shared/infra/http/auth.decorators.js';
import type { HubAuthContext } from '../../application/authenticate-hub-token.use-case.js';

export type { HubAuthContext };

export const IS_HUB_AUTH_KEY = 'isHubAuth';

/**
 * Marks a route (or controller) as a Hub route: only a hub token (`typ: hub+jwt`) of an existing, not deregistered
 * hub gets in, read by `@CurrentHub()`. The global user guard skips it (`@Public()`), and the global
 * `HubTokenGuard` (registered by HubsModule, BEFORE ThrottlingModule) enforces it, so a per-hub rate limit can read
 * `request.hub`. A user access token is refused here (and a hub token is refused on user routes).
 */
export const HubAuth = (): MethodDecorator & ClassDecorator =>
  applyDecorators(Public(), SetMetadata(IS_HUB_AUTH_KEY, true));

/** Injects the HubAuthContext the hub token guard stored in `request.hub`. */
export const CurrentHub = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): HubAuthContext => {
    const hub = ctx.switchToHttp().getRequest<{ hub?: HubAuthContext }>().hub;
    // Reaching a handler without it means the route lacks @HubAuth(): a bug.
    if (!hub) throw new Error('CurrentHub used on a route without @HubAuth()');
    return hub;
  },
);
