import { userIdTracker } from './user-id.tracker.js';

describe('userIdTracker', () => {
  it('uses the authenticated user, else the IP', () => {
    expect(userIdTracker({ ip: '1.2.3.4', auth: { userId: 'u1' } })).toBe(
      'user:u1',
    );
    expect(userIdTracker({ ip: '1.2.3.4' })).toBe('ip:1.2.3.4');
  });
});
