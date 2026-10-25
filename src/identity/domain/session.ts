import { Entity } from '../../shared/domain/entity.js';

export type DevicePlatform = 'android' | 'ios' | 'hub' | 'web' | 'other';
export type SessionRevokedReason =
  'logout' | 'revoked' | 'refresh_reuse' | 'password_change';

export type SessionProps = {
  userId: string;
  deviceName: string;
  devicePlatform: DevicePlatform;
  refreshTokenHash: string;
  refreshExpiresAt: Date;
  lastUsedAt: Date;
  lastIp: string | null;
  userAgent: string | null;
  revokedAt: Date | null;
  revokedReason: SessionRevokedReason | null;
  createdAt?: Date;
};

const DAY_MS = 86_400_000;

function addDays(now: Date, days: number): Date {
  return new Date(now.getTime() + days * DAY_MS);
}

export class Session extends Entity<SessionProps> {
  static start(input: {
    id?: string;
    userId: string;
    deviceName: string;
    devicePlatform: DevicePlatform;
    refreshTokenHash: string;
    idleDays: number;
    now: Date;
    ip: string | null;
    userAgent: string | null;
  }): Session {
    return new Session(
      {
        userId: input.userId,
        deviceName: input.deviceName,
        devicePlatform: input.devicePlatform,
        refreshTokenHash: input.refreshTokenHash,
        refreshExpiresAt: addDays(input.now, input.idleDays),
        lastUsedAt: input.now,
        lastIp: input.ip,
        userAgent: input.userAgent,
        revokedAt: null,
        revokedReason: null,
      },
      input.id,
    );
  }

  static restore(props: SessionProps, id: string): Session {
    return new Session(props, id);
  }

  isActive(now: Date): boolean {
    return this.props.revokedAt === null && this.props.refreshExpiresAt > now;
  }

  rotate(
    newHash: string,
    idleDays: number,
    now: Date,
    ip: string | null,
    userAgent: string | null,
  ): void {
    this.props = {
      ...this.props,
      refreshTokenHash: newHash,
      refreshExpiresAt: addDays(now, idleDays),
      lastUsedAt: now,
      lastIp: ip,
      userAgent,
    };
  }

  revoke(reason: SessionRevokedReason, now: Date): void {
    if (this.props.revokedAt !== null) return;
    this.props = { ...this.props, revokedAt: now, revokedReason: reason };
  }

  get userId(): string {
    return this.props.userId;
  }
  get deviceName(): string {
    return this.props.deviceName;
  }
  get devicePlatform(): DevicePlatform {
    return this.props.devicePlatform;
  }
  get refreshTokenHash(): string {
    return this.props.refreshTokenHash;
  }
  get refreshExpiresAt(): Date {
    return this.props.refreshExpiresAt;
  }
  get lastUsedAt(): Date {
    return this.props.lastUsedAt;
  }
  get lastIp(): string | null {
    return this.props.lastIp;
  }
  get userAgent(): string | null {
    return this.props.userAgent;
  }
  get revokedAt(): Date | null {
    return this.props.revokedAt;
  }
  get revokedReason(): SessionRevokedReason | null {
    return this.props.revokedReason;
  }
  get createdAt(): Date | undefined {
    return this.props.createdAt;
  }
}
