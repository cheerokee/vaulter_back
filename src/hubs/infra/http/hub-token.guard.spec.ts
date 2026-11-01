import type { ExecutionContext } from '@nestjs/common';
import { Controller, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../../shared/infra/http/auth.decorators.js';
import { UnauthenticatedError } from '../../../shared/domain/errors.js';
import type { AuthenticateHubTokenUseCase } from '../../application/authenticate-hub-token.use-case.js';
import { HubAuth, IS_HUB_AUTH_KEY } from './hub-auth.decorators.js';
import { HubTokenGuard } from './hub-token.guard.js';

@Controller()
class Probe {
  @HubAuth()
  @Get('hub')
  hub(): void {}

  @Get('user')
  user(): void {}
}

// Referência ao handler sem desvincular `this` (como o Nest faz via getHandler()).
const handlerOf = (name: keyof Probe): (() => void) =>
  Object.getOwnPropertyDescriptor(Probe.prototype, name)!.value as () => void;

const authenticate = { execute: vi.fn() };
const guard = new HubTokenGuard(
  new Reflector(),
  authenticate as unknown as AuthenticateHubTokenUseCase,
);
const contextFor = (handler: keyof Probe, authorization?: string) => {
  const req: { headers: Record<string, string>; hub?: unknown } = {
    headers: authorization ? { authorization } : {},
  };
  const ctx = {
    getHandler: () => handlerOf(handler),
    getClass: () => Probe,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { ctx, req };
};

beforeEach(() => vi.clearAllMocks());

describe('@HubAuth()', () => {
  it('marks the route as a hub route and as public for the user guard', () => {
    const reflector = new Reflector();
    expect(reflector.get(IS_HUB_AUTH_KEY, handlerOf('hub'))).toBe(true);
    expect(reflector.get(IS_PUBLIC_KEY, handlerOf('hub'))).toBe(true);
    expect(reflector.get(IS_HUB_AUTH_KEY, handlerOf('user'))).toBeUndefined();
  });
});

describe('HubTokenGuard', () => {
  it('ignores routes without @HubAuth()', async () => {
    const { ctx } = contextFor('user');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(authenticate.execute).not.toHaveBeenCalled();
  });

  it('stores the authenticated hub in request.hub', async () => {
    authenticate.execute.mockResolvedValue({ hubId: 'h1' });
    const { ctx, req } = contextFor('hub', 'Bearer tok');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(authenticate.execute).toHaveBeenCalledWith('tok', expect.any(Date));
    expect(req.hub).toEqual({ hubId: 'h1' });
  });

  it('refuses a missing or malformed Authorization header with invalid-hub-token', async () => {
    for (const header of [undefined, 'tok', 'Basic abc', 'Bearer a b']) {
      const { ctx } = contextFor('hub', header);
      await expect(guard.canActivate(ctx)).rejects.toMatchObject({
        constructor: UnauthenticatedError,
        code: 'invalid-hub-token',
      });
    }
    expect(authenticate.execute).not.toHaveBeenCalled();
  });

  it('propagates the refusal of the token (e.g. a user token)', async () => {
    authenticate.execute.mockRejectedValue(
      new UnauthenticatedError('invalid-hub-token', 'x'),
    );
    const { ctx, req } = contextFor('hub', 'Bearer user-token');
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      code: 'invalid-hub-token',
    });
    expect(req.hub).toBeUndefined();
  });
});
