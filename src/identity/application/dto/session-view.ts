import type { Session } from '../../domain/session.js';

export type SessionView = {
  id: string;
  deviceName: string;
  devicePlatform: string;
  createdAt: Date;
  lastUsedAt: Date;
  lastIp: string | null;
  current: boolean;
};

export function toSessionView(
  session: Session,
  currentSessionId: string,
): SessionView {
  if (!session.createdAt) {
    throw new Error('Session without createdAt cannot be viewed');
  }
  return {
    id: session.id,
    deviceName: session.deviceName,
    devicePlatform: session.devicePlatform,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    lastIp: session.lastIp,
    current: session.id === currentSessionId,
  };
}
