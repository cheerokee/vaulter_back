import { DomainValidationError } from '../../shared/domain/errors.js';
import { Entity } from '../../shared/domain/entity.js';
import type { Enrollment } from './enrollment.js';

export type HubProps = {
  ownerUserId: string;
  name: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
  lastSeenAt: Date | null;
  /** Tombstone: a deregistered hub is refused everywhere. */
  deletedAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
};

/** Trimmed name, 1 to 255 characters (422 `hub-name-invalid`). */
export function assertHubName(raw: string): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.length < 1 || name.length > 255) {
    throw new DomainValidationError(
      'hub-name-invalid',
      'The name must have between 1 and 255 characters.',
    );
  }
  return name;
}

export class Hub extends Entity<HubProps> {
  /**
   * Creates the hub from a claimable enrollment (throws `claim-code-invalid` otherwise). The caller then runs
   * `enrollment.markClaimed(hub.id)`.
   */
  static claim(input: {
    enrollment: Enrollment;
    ownerUserId: string;
    name: string;
    now: Date;
  }): Hub {
    input.enrollment.assertClaimable(input.now);
    return new Hub({
      ownerUserId: input.ownerUserId,
      name: assertHubName(input.name),
      signingPublicKey: input.enrollment.signingPublicKey,
      encryptionPublicKey: input.enrollment.encryptionPublicKey,
      lastSeenAt: null,
      deletedAt: null,
      createdAt: input.now,
    });
  }

  static restore(props: HubProps, id: string): Hub {
    return new Hub(props, id);
  }

  get ownerUserId(): string {
    return this.props.ownerUserId;
  }
  get name(): string {
    return this.props.name;
  }
  get signingPublicKey(): string {
    return this.props.signingPublicKey;
  }
  get encryptionPublicKey(): string {
    return this.props.encryptionPublicKey;
  }
  get lastSeenAt(): Date | null {
    return this.props.lastSeenAt;
  }
  get deletedAt(): Date | null {
    return this.props.deletedAt;
  }
  get isDeregistered(): boolean {
    return this.props.deletedAt !== null;
  }
  get createdAt(): Date | undefined {
    return this.props.createdAt;
  }

  rename(name: string): void {
    this.props = { ...this.props, name: assertHubName(name) };
  }

  deregister(now: Date): void {
    if (this.props.deletedAt === null) {
      this.props = { ...this.props, deletedAt: now };
    }
  }

  touch(now: Date): void {
    this.props = { ...this.props, lastSeenAt: now };
  }
}
