import {
  ConflictError,
  DomainValidationError,
} from '../../shared/domain/errors.js';
import { Entity } from '../../shared/domain/entity.js';

/** Reserved size of a new space when the creator does not choose one (10 GiB, spec storage-backup §4.4). */
export const SPACE_STORAGE_QUOTA_DEFAULT_BYTES = 10_737_418_240;
/** Smallest and largest reserved size of a space: 1 GiB .. 5 TiB. */
export const SPACE_STORAGE_QUOTA_MIN_BYTES = 1_073_741_824;
export const SPACE_STORAGE_QUOTA_MAX_BYTES = 5_497_558_138_880;

/**
 * `encrypted_backup`: the backend only stores ciphertext. `active_cloud`: the server holds a copy of every key version
 * and reads the space (spec active-cloud §4.1). Changed only by the `cloud` module, through `SpaceCloud`.
 */
export type CloudMode = 'encrypted_backup' | 'active_cloud';

export type SpaceProps = {
  organizationId: string;
  name: string;
  currentKeyVersion: number;
  keyRotationRequired: boolean;
  /** Reserved size (bytes): counts against the organization quota and the capacity of every hub it is on. */
  storageQuotaBytes: number;
  /** Optional on restore (defaults: `encrypted_backup`, not activated, online LLM allowed). */
  cloudMode?: CloudMode;
  /** When the space last became `active_cloud`; null while `encrypted_backup`. */
  cloudActivatedAt?: Date | null;
  /** The space allows an online language model (required by the active cloud). */
  allowOnlineLlm?: boolean;
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

function assertStorageQuota(bytes: number): number {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < SPACE_STORAGE_QUOTA_MIN_BYTES ||
    bytes > SPACE_STORAGE_QUOTA_MAX_BYTES
  ) {
    throw new DomainValidationError(
      'space-storage-quota-invalid',
      'The space size must be a whole number of bytes between 1 GiB and 5 TiB.',
    );
  }
  return bytes;
}

export class Space extends Entity<SpaceProps> {
  static create(input: {
    organizationId: string;
    name: string;
    now: Date;
    /** Defaults to `SPACE_STORAGE_QUOTA_DEFAULT_BYTES`. */
    storageQuotaBytes?: number;
  }): Space {
    return new Space({
      organizationId: input.organizationId,
      name: assertName(input.name),
      currentKeyVersion: 1,
      keyRotationRequired: false,
      storageQuotaBytes: assertStorageQuota(
        input.storageQuotaBytes ?? SPACE_STORAGE_QUOTA_DEFAULT_BYTES,
      ),
      createdAt: input.now,
    });
  }

  static restore(props: SpaceProps, id: string): Space {
    return new Space(props, id);
  }

  rename(name: string): void {
    this.props = { ...this.props, name: assertName(name) };
  }

  /**
   * New reserved size. Never below `usedBytes` (every stored version, trash included): 422
   * `space-storage-quota-below-usage`. Whether a growth fits (organization quota, hub capacity) is the caller's
   * check, with the returned `fromBytes`/`toBytes`.
   */
  resizeStorage(
    bytes: number,
    usedBytes: number,
  ): { fromBytes: number; toBytes: number } {
    const toBytes = assertStorageQuota(bytes);
    if (toBytes < usedBytes) {
      throw new DomainValidationError(
        'space-storage-quota-below-usage',
        'The space size cannot be smaller than what it already stores (trash included).',
        { usedBytes },
      );
    }
    const fromBytes = this.props.storageQuotaBytes;
    this.props = { ...this.props, storageQuotaBytes: toBytes };
    return { fromBytes, toBytes };
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
        { expectedVersion: this.props.currentKeyVersion + 1 },
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
  get storageQuotaBytes(): number {
    return this.props.storageQuotaBytes;
  }
  get cloudMode(): CloudMode {
    return this.props.cloudMode ?? 'encrypted_backup';
  }
  get cloudActivatedAt(): Date | null {
    return this.props.cloudActivatedAt ?? null;
  }
  get allowOnlineLlm(): boolean {
    return this.props.allowOnlineLlm ?? true;
  }
  get createdAt(): Date | undefined {
    return this.props.createdAt;
  }
  get updatedAt(): Date | undefined {
    return this.props.updatedAt;
  }
}
