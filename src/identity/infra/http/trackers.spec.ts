import { loginEmailTracker } from './login-email.tracker.js';
import { userIdTracker } from './user-id.tracker.js';

describe('rate limit trackers', () => {
  it('login tracker normalizes the body e-mail', () => {
    expect(loginEmailTracker({ body: { email: '  Ana@Example.COM ' } })).toBe(
      'email:ana@example.com',
    );
  });

  it('login tracker falls back to the IP without a string e-mail', () => {
    expect(loginEmailTracker({ ip: '1.2.3.4', body: { email: 5 } })).toBe(
      'ip:1.2.3.4',
    );
    expect(loginEmailTracker({ ip: '1.2.3.4' })).toBe('ip:1.2.3.4');
  });

  it('user tracker uses the authenticated user, else the IP', () => {
    expect(userIdTracker({ ip: '1.2.3.4', auth: { userId: 'u1' } })).toBe(
      'user:u1',
    );
    expect(userIdTracker({ ip: '1.2.3.4' })).toBe('ip:1.2.3.4');
  });
});
