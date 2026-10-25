import { Session } from '../../domain/session.js';
import { UserSessionTypeormEntity } from './user-session.entity.js';

export const UserSessionMapper = {
  toDomain(row: UserSessionTypeormEntity): Session {
    return Session.restore(
      {
        userId: row.userId,
        deviceName: row.deviceName,
        devicePlatform: row.devicePlatform,
        refreshTokenHash: row.refreshTokenHash,
        refreshExpiresAt: row.refreshExpiresAt,
        lastUsedAt: row.lastUsedAt,
        lastIp: row.lastIp,
        userAgent: row.userAgent,
        revokedAt: row.revokedAt,
        revokedReason: row.revokedReason,
        createdAt: row.createdAt,
      },
      row.id,
    );
  },

  toPersistence(session: Session): Partial<UserSessionTypeormEntity> {
    return {
      id: session.id,
      userId: session.userId,
      deviceName: session.deviceName,
      devicePlatform: session.devicePlatform,
      refreshTokenHash: session.refreshTokenHash,
      refreshExpiresAt: session.refreshExpiresAt,
      lastUsedAt: session.lastUsedAt,
      lastIp: session.lastIp,
      userAgent: session.userAgent,
      revokedAt: session.revokedAt,
      revokedReason: session.revokedReason,
    };
  },
};
