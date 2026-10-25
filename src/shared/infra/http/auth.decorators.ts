import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
} from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** The authenticated caller: the user and the device session of the access token. */
export type AuthContext = { userId: string; sessionId: string };

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
