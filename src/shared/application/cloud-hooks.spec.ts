import { CloudReservePendingHooks } from './cloud-reserve-pending-hooks.js';
import { SpaceCloudDeactivatedHooks } from './space-cloud-deactivated-hooks.js';

describe('SpaceCloudDeactivatedHooks / CloudReservePendingHooks', () => {
  it('run every hook in order, refuse a duplicate name and unregister', async () => {
    const off = new SpaceCloudDeactivatedHooks();
    const pending = new CloudReservePendingHooks();
    const calls: string[] = [];
    off.register({
      name: 'a',
      onSpaceCloudDeactivated: async () => void calls.push('off'),
    });
    pending.register({
      name: 'a',
      onPending: async () => void calls.push('pending'),
    });
    expect(() =>
      off.register({ name: 'a', onSpaceCloudDeactivated: vi.fn() }),
    ).toThrow(/already registered/);
    expect(() => pending.register({ name: 'a', onPending: vi.fn() })).toThrow(
      /already registered/,
    );
    await off.run({
      organizationId: 'o',
      spaceId: 's',
      actorUserId: 'u',
      now: new Date(),
    });
    await pending.run({
      organizationId: 'o',
      spaceId: 's',
      conversationId: 'c',
      messageId: 'm',
      reason: 'sent',
    });
    expect(calls).toEqual(['off', 'pending']);
    off.unregister('a');
    pending.unregister('a');
    await pending.run({
      organizationId: 'o',
      spaceId: 's',
      conversationId: 'c',
      messageId: 'm',
      reason: 'sent',
    });
    expect(calls).toHaveLength(2);
  });
});
