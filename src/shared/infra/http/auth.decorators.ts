import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
} from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * The authenticated caller: the user, the device session of the access token and the Hub that session is bound to
 * (`POST /hub/user-sessions`; from the session row) or null.
 */
export type AuthContext = {
  userId: string;
  sessionId: string;
  hubId: string | null;
};

/** Marks a route (or controller) as open: the global access token guard skips it. */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);

/** Injects the AuthContext the guard stored in `request.auth`. */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext => {
    const auth = ctx.switchToHttp().getRequest<{ auth?: AuthContext }>().auth;
    // Reaching a handler without auth means the route is @Public or the guard is off: a bug.
    if (!auth)
      throw new Error('CurrentAuth used on a route without authentication');
    return auth;
  },
);
