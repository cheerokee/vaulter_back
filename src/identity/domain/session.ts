import { DomainValidationError } from '../../shared/domain/errors.js';
import { Entity } from '../../shared/domain/entity.js';

export type DevicePlatform = 'android' | 'ios' | 'hub' | 'web' | 'other';
export type SessionRevokedReason =
  | 'logout'
  | 'revoked'
  | 'refresh_reuse'
  | 'password_change'
  | 'account_recovery'
  /** A hub-bound session whose person lost every role on that hub (or the hub was deregistered). */
  | 'hub_access_lost';

export type SessionProps = {
  userId: string;
  deviceName: string;
  devicePlatform: DevicePlatform;
  /** The hub that opened the session (`POST /hub/user-sessions`); set exactly when the platform is `hub`. */
  hubId: string | null;
  refreshTokenHash: string;
  refreshExpiresAt: Date;
  lastUsedAt: Date;
  lastIp: string | null;
  userAgent: string | null;
  revokedAt: Date | null;
  revokedReason: SessionRevokedReason | null;
  createdAt?: Date;
};

const PLATFORMS: readonly string[] = ['android', 'ios', 'hub', 'web', 'other'];

/** Validates the device that opens a session; returns the trimmed name. */
export function assertDevice(device: unknown): {
  name: string;
  platform: DevicePlatform;
} {
  const d = device as { name?: unknown; platform?: unknown } | null;
  const name = typeof d?.name === 'string' ? d.name.trim() : '';
  if (
    typeof device !== 'object' ||
    device === null ||
    Array.isArray(device) ||
    name.length < 1 ||
    name.length > 100 ||
    typeof d?.platform !== 'string' ||
    !PLATFORMS.includes(d.platform)
  ) {
    throw new DomainValidationError(
      'device-invalid',
      'The device name or platform is invalid.',
    );
  }
  return { name, platform: d.platform as DevicePlatform };
}

/**
 * `assertDevice` for the routes that open a session WITHOUT a hub (register, account recovery): the `hub` platform is
 * refused up front, before any proof is checked, so the answer never depends on the account or the proof.
 * (`/auth/login` refuses it with `invalid-credentials`, after the usual verification, instead.)
 */
export function assertDeviceWithoutHub(device: unknown): {
  name: string;
  platform: DevicePlatform;
} {
  const checked = assertDevice(device);
  if (checked.platform === 'hub') {
    throw new DomainValidationError(
      'device-invalid',
      'The device name or platform is invalid.',
    );
  }
  return checked;
}

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
    /** Only for a session opened by a hub; required then (and only then). */
    hubId?: string | null;
    refreshTokenHash: string;
    idleDays: number;
    now: Date;
    ip: string | null;
    userAgent: string | null;
  }): Session {
    const device = assertDevice({
      name: input.deviceName,
      platform: input.devicePlatform,
    });
    const hubId = input.hubId ?? null;
    // Sessão de Hub só nasce pelo Hub (presa a ele); nenhuma outra plataforma leva Hub. Mesmo CHECK no banco.
    if ((device.platform === 'hub') !== (hubId !== null)) {
      throw new DomainValidationError(
        'device-invalid',
        'The device name or platform is invalid.',
      );
    }
    return new Session(
      {
        userId: input.userId,
        deviceName: device.name,
        devicePlatform: device.platform,
        hubId,
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
  get hubId(): string | null {
    return this.props.hubId;
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
