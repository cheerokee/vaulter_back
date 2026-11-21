import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  NotFoundException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { HubAuthContext } from '../../application/hub-auth-context.js';
import { HubAuth } from './hub-auth.decorators.js';

export const PC_HUB_ONLY_KEY = 'pcHubOnly';

/**
 * Hub route that only a `pc` hub (the agent) reaches: `@HubAuth()` plus the kind check. A hub of another kind gets
 * EXACTLY what Nest answers for an unmatched route (`Cannot <METHOD> <url>`, see `PlatformPermissionGuard`), so an
 * appliance cannot tell the agent routes exist. The guard is global (`PcHubOnlyGuard`, APP_GUARD of the `agents`
 * module, after the hub token guard and BEFORE the throttler).
 */
export const PcHubOnly = (): MethodDecorator & ClassDecorator =>
  applyDecorators(HubAuth(), SetMetadata(PC_HUB_ONLY_KEY, true));

/** The kind of a hub; the `hubs` module provides it (`HubDirectory.kindOf`), the `agents` module binds it. */
export abstract class HubKindLookup {
  abstract kindOf(hubId: string): Promise<'appliance' | 'pc' | null>;
}

@Injectable()
export class PcHubOnlyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly kinds: HubKindLookup,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const pcOnly = this.reflector.getAllAndOverride<boolean | undefined>(
      PC_HUB_ONLY_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!pcOnly) return true;
    const request = context.switchToHttp().getRequest<{
      hub?: HubAuthContext;
      method: string;
      originalUrl: string;
    }>();
    // The hub token guard runs first and sets it: without it the route lacks the guard order (a bug, fail closed).
    if (!request.hub) throw new Error('PcHubOnlyGuard needs request.hub');
    if ((await this.kinds.kindOf(request.hub.hubId)) !== 'pc') {
      // Exactly what Nest answers for an unmatched route (Express adapter: method + originalUrl).
      throw new NotFoundException(
        `Cannot ${request.method} ${request.originalUrl}`,
      );
    }
    return true;
  }
}
