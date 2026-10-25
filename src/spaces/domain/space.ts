import {
  ConflictError,
  DomainValidationError,
} from '../../shared/domain/errors.js';
import { Entity } from '../../shared/domain/entity.js';

export type SpaceProps = {
  organizationId: string;
  name: string;
  currentKeyVersion: number;
  keyRotationRequired: boolean;
  createdAt?: Date;
  updatedAt?: Date;
};

function assertName(raw: string): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.length < 1 || name.length > 255) {
    throw new DomainValidationError(
      'space-name-invalid',
      'The name must have between 1 and 255 characters.',
    );
  }
  return name;
}

export class Space extends Entity<SpaceProps> {
  static create(input: {
    organizationId: string;
    name: string;
    now: Date;
  }): Space {
    return new Space({
      organizationId: input.organizationId,
      name: assertName(input.name),
      currentKeyVersion: 1,
      keyRotationRequired: false,
      createdAt: input.now,
    });
  }

  static restore(props: SpaceProps, id: string): Space {
    return new Space(props, id);
  }

  rename(name: string): void {
    this.props = { ...this.props, name: assertName(name) };
  }

  /** A member left (space or organization): the next key version must exclude them. */
  markRotationRequired(): void {
    this.props = { ...this.props, keyRotationRequired: true };
  }

  /**
   * Who may generate a new key version: anyone in the space while a rotation is pending (someone left), only a
   * manager otherwise (manual rotation, e.g. a suspected leak). Bounds the version count: add, rewrap and recover
   * need every version in one request.
   */
  assertRotationAllowed(byManager: boolean): void {
    if (!this.props.keyRotationRequired && !byManager) {
      throw new ConflictError(
        'key-rotation-not-required',
        'No key rotation is pending; only a space manager can rotate the key now.',
      );
    }
  }

  /** Accepts only the immediate next version; clears the pending-rotation flag. */
  completeRotation(nextVersion: number): void {
    if (nextVersion !== this.props.currentKeyVersion + 1) {
      throw new ConflictError(
        'key-rotation-mismatch',
        'The key version must be the current version plus one.',
      );
    }
    this.props = {
      ...this.props,
      currentKeyVersion: nextVersion,
      keyRotationRequired: false,
    };
  }

  get organizationId(): string {
    return this.props.organizationId;
  }
  get name(): string {
    return this.props.name;
  }
  get currentKeyVersion(): number {
    return this.props.currentKeyVersion;
  }
  get keyRotationRequired(): boolean {
    return this.props.keyRotationRequired;
  }
  get createdAt(): Date | undefined {
    return this.props.createdAt;
  }
  get updatedAt(): Date | undefined {
    return this.props.updatedAt;
  }
}
