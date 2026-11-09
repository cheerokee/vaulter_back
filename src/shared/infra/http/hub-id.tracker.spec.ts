import { hubIdTracker } from './hub-id.tracker.js';

describe('hubIdTracker', () => {
  it('uses the authenticated hub, else the IP', () => {
    expect(hubIdTracker({ ip: '1.2.3.4', hub: { hubId: 'h1' } })).toBe(
      'hub:h1',
    );
    expect(hubIdTracker({ ip: '1.2.3.4' })).toBe('ip:1.2.3.4');
    // a user token on the request is not a hub
    expect(hubIdTracker({ ip: '1.2.3.4', auth: { userId: 'u1' } })).toBe(
      'ip:1.2.3.4',
    );
  });
});
