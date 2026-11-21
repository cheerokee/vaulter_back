import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  HubKindLookup,
  PC_HUB_ONLY_KEY,
  PcHubOnlyGuard,
} from './pc-hub-only.guard.js';

const HUB = '01a1fef8-a35b-7305-8d9f-5c289cdf425b';

class Handler {}
const open = () => undefined;
const agent = () => undefined;
Reflect.defineMetadata(PC_HUB_ONLY_KEY, true, agent);

const context = (
  handler: () => void,
  request: Record<string, unknown>,
): ExecutionContext =>
  ({
    getHandler: () => handler,
    getClass: () => Handler,
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

describe('PcHubOnlyGuard', () => {
  const kinds = { kindOf: vi.fn() };
  const guard = new PcHubOnlyGuard(
    new Reflector(),
    kinds as unknown as HubKindLookup,
  );
  const req = {
    hub: { hubId: HUB },
    method: 'PUT',
    originalUrl: '/hub/agent/tools',
  };

  beforeEach(() => kinds.kindOf.mockReset());

  it('lets a pc hub through', async () => {
    kinds.kindOf.mockResolvedValue('pc');
    await expect(guard.canActivate(context(agent, req))).resolves.toBe(true);
  });

  it('answers an appliance and an unknown hub with the not-found of an unmatched route', async () => {
    for (const kind of ['appliance', null]) {
      kinds.kindOf.mockResolvedValue(kind);
      const error = await guard
        .canActivate(context(agent, req))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toBe(
        'Cannot PUT /hub/agent/tools',
      );
    }
  });

  it('ignores routes without the marker and fails closed without request.hub', async () => {
    await expect(guard.canActivate(context(open, req))).resolves.toBe(true);
    expect(kinds.kindOf).not.toHaveBeenCalled();
    await expect(
      guard.canActivate(context(agent, { method: 'PUT' })),
    ).rejects.toThrow(/request\.hub/);
  });
});
