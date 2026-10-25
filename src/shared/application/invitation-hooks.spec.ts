import { DomainValidationError } from '../domain/errors.js';
import {
  InvitationHooks,
  type InvitationAcceptedContext,
  type InvitationCreatedContext,
} from './invitation-hooks.js';

const created: InvitationCreatedContext = {
  organizationId: 'o1',
  invitationId: 'i1',
  actorId: 'a1',
  spaces: [{ spaceId: 's1', roleKey: 'space_reader' }],
};
const accepted: InvitationAcceptedContext = {
  organizationId: 'o1',
  invitationId: 'i1',
  userId: 'u1',
  now: new Date('2026-10-25T00:00:00Z'),
};

describe('InvitationHooks', () => {
  it('without subscribers: spaces are rejected, never dropped', async () => {
    const hooks = new InvitationHooks();
    await expect(hooks.validateAndRecord(created)).rejects.toMatchObject({
      constructor: DomainValidationError,
      code: 'spaces-not-supported',
    });
  });

  it('without subscribers: onAccepted is a no-op', async () => {
    await expect(
      new InvitationHooks().onAccepted(accepted),
    ).resolves.toBeUndefined();
  });

  it('runs validateAndRecord and onAccepted sequentially in order', async () => {
    const hooks = new InvitationHooks();
    const order: string[] = [];
    hooks.register({
      name: 'a',
      validateAndRecord: async (c) => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(`a:v:${c.invitationId}`);
      },
      onAccepted: async (c) => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(`a:o:${c.userId}`);
      },
    });
    hooks.register({
      name: 'b',
      validateAndRecord: async () => void order.push('b:v'),
      onAccepted: async () => void order.push('b:o'),
    });
    await hooks.validateAndRecord(created);
    await hooks.onAccepted(accepted);
    expect(order).toEqual(['a:v:i1', 'b:v', 'a:o:u1', 'b:o']);
  });

  it('propagates errors from both phases', async () => {
    const hooks = new InvitationHooks();
    hooks.register({
      name: 'a',
      validateAndRecord: () => Promise.reject(new Error('v-boom')),
      onAccepted: () => Promise.reject(new Error('o-boom')),
    });
    await expect(hooks.validateAndRecord(created)).rejects.toThrow('v-boom');
    await expect(hooks.onAccepted(accepted)).rejects.toThrow('o-boom');
  });

  it('unregister removes the hook (back to spaces-not-supported); duplicates rejected', async () => {
    const hooks = new InvitationHooks();
    const hook = {
      name: 'a',
      validateAndRecord: vi.fn(),
      onAccepted: vi.fn(),
    };
    hooks.register(hook);
    expect(() => hooks.register(hook)).toThrow(/already registered/);
    hooks.unregister('a');
    await expect(hooks.validateAndRecord(created)).rejects.toThrow(
      DomainValidationError,
    );
  });
});
