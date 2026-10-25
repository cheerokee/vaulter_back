import { Session } from '../../src/identity/domain/session.js';

export const NOW = new Date('2026-10-24T12:00:00Z');
export const hexHash = (fill: number) => Buffer.alloc(32, fill).toString('hex');

export function makeSession(
  overrides: Partial<{
    id: string;
    userId: string;
    hash: string;
    expiresAt: Date;
    revoked: boolean;
  }> = {},
): Session {
  const session = Session.restore(
    {
      userId: overrides.userId ?? 'u1',
      deviceName: 'Pixel',
      devicePlatform: 'android',
      refreshTokenHash: overrides.hash ?? hexHash(1),
      refreshExpiresAt: overrides.expiresAt ?? new Date('2026-11-24T12:00:00Z'),
      lastUsedAt: new Date('2026-10-24T11:00:00Z'),
      lastIp: '1.2.3.4',
      userAgent: null,
      revokedAt: overrides.revoked ? new Date('2026-10-24T11:30:00Z') : null,
      revokedReason: overrides.revoked ? 'logout' : null,
      createdAt: new Date('2026-10-24T10:00:00Z'),
    },
    overrides.id ?? 's1',
  );
  return session;
}
