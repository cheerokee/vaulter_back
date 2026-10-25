import { isUuidV7 } from '../../shared/domain/id.js';
import { Session } from './session.js';

const now = new Date('2026-10-24T12:00:00Z');
const day = 86_400_000;

const start = () =>
  Session.start({
    userId: 'u1',
    deviceName: 'Pixel',
    devicePlatform: 'android',
    refreshTokenHash: 'h1',
    idleDays: 30,
    now,
    ip: '1.2.3.4',
    userAgent: 'ua',
  });

describe('Session', () => {
  it('start sets expiry now+30d and is active', () => {
    const s = start();
    expect(isUuidV7(s.id)).toBe(true);
    expect(s.refreshExpiresAt.getTime()).toBe(now.getTime() + 30 * day);
    expect(s.lastUsedAt).toEqual(now);
    expect(s.revokedAt).toBeNull();
    expect(s.revokedReason).toBeNull();
    expect(s.isActive(now)).toBe(true);
  });

  it('start keeps a given id', () => {
    const s = Session.start({
      id: 'given',
      userId: 'u1',
      deviceName: 'd',
      devicePlatform: 'web',
      refreshTokenHash: 'h',
      idleDays: 1,
      now,
      ip: null,
      userAgent: null,
    });
    expect(s.id).toBe('given');
  });

  it('is inactive after expiry and after revoke', () => {
    const s = start();
    expect(s.isActive(new Date(now.getTime() + 30 * day))).toBe(false);
    expect(s.isActive(new Date(now.getTime() + 30 * day - 1))).toBe(true);
    s.revoke('logout', now);
    expect(s.isActive(now)).toBe(false);
  });

  it('rotate renews from the new now', () => {
    const s = start();
    const later = new Date(now.getTime() + 10 * day);
    s.rotate('h2', 30, later, '5.6.7.8', 'ua2');
    expect(s.refreshTokenHash).toBe('h2');
    expect(s.refreshExpiresAt.getTime()).toBe(later.getTime() + 30 * day);
    expect(s.lastUsedAt).toEqual(later);
    expect(s.lastIp).toBe('5.6.7.8');
    expect(s.userAgent).toBe('ua2');
  });

  it('revoke twice keeps first reason and date', () => {
    const s = start();
    const t2 = new Date(now.getTime() + 1000);
    s.revoke('logout', now);
    s.revoke('revoked', t2);
    expect(s.revokedReason).toBe('logout');
    expect(s.revokedAt).toEqual(now);
  });
});
