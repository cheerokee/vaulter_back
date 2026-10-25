import { DomainValidationError } from '../../shared/domain/errors.js';
import { Entity } from '../../shared/domain/entity.js';
import {
  assertEncryptedPrivateKey,
  assertKdfSalt,
  assertPublicKey,
} from './crypto-material.js';
import { assertEmailLength, normalizeEmail } from './email.js';
import { parseKdfParams, type KdfParams } from './kdf-params.js';

export type UserProps = {
  name: string;
  email: string;
  authHash: string;
  kdfSalt: string;
  kdfParams: KdfParams;
  publicKey: string;
  encryptedPrivateKey: string;
  createdAt?: Date;
  updatedAt?: Date;
};

function assertAuthHash(authHash: string): string {
  if (typeof authHash !== 'string' || authHash.length === 0) {
    throw new DomainValidationError(
      'auth-hash-invalid',
      'The auth hash is required.',
    );
  }
  return authHash;
}

export class User extends Entity<UserProps> {
  /**
   * Validates and normalizes everything a registration carries except the auth hash, so the
   * caller can reject bad input before the expensive hashing. Throws DomainValidationError.
   */
  static validateRegistration(input: {
    name: string;
    email: string;
    kdfSalt: string;
    kdfParams: unknown;
    publicKey: string;
    encryptedPrivateKey: string;
  }): Omit<UserProps, 'authHash' | 'createdAt' | 'updatedAt'> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length < 1 || name.length > 255) {
      throw new DomainValidationError(
        'user-name-invalid',
        'The name must have between 1 and 255 characters.',
      );
    }
    return {
      name,
      email: assertEmailLength(normalizeEmail(input.email)),
      kdfSalt: assertKdfSalt(input.kdfSalt),
      kdfParams: parseKdfParams(input.kdfParams),
      publicKey: assertPublicKey(input.publicKey),
      encryptedPrivateKey: assertEncryptedPrivateKey(input.encryptedPrivateKey),
    };
  }

  /** `now` becomes `createdAt`: the domain owns the creation time, the database only stores it. */
  static register(input: {
    name: string;
    email: string;
    authHash: string;
    kdfSalt: string;
    kdfParams: unknown;
    publicKey: string;
    encryptedPrivateKey: string;
    now: Date;
  }): User {
    const fields = User.validateRegistration(input);
    return new User({
      ...fields,
      authHash: assertAuthHash(input.authHash),
      createdAt: input.now,
    });
  }

  static restore(props: UserProps, id: string): User {
    return new User(props, id);
  }

  /** Validates the key material of a password change (everything but the auth hash). */
  static validatePasswordChange(input: {
    kdfSalt: string;
    kdfParams: unknown;
    encryptedPrivateKey: string;
  }): Pick<UserProps, 'kdfSalt' | 'kdfParams' | 'encryptedPrivateKey'> {
    return {
      kdfSalt: assertKdfSalt(input.kdfSalt),
      kdfParams: parseKdfParams(input.kdfParams),
      encryptedPrivateKey: assertEncryptedPrivateKey(input.encryptedPrivateKey),
    };
  }

  changePassword(input: {
    authHash: string;
    kdfSalt: string;
    kdfParams: unknown;
    encryptedPrivateKey: string;
  }): void {
    const authHash = assertAuthHash(input.authHash);
    this.props = {
      ...this.props,
      authHash,
      ...User.validatePasswordChange(input),
    };
  }

  get name(): string {
    return this.props.name;
  }
  get email(): string {
    return this.props.email;
  }
  get authHash(): string {
    return this.props.authHash;
  }
  get kdfSalt(): string {
    return this.props.kdfSalt;
  }
  get kdfParams(): KdfParams {
    return this.props.kdfParams;
  }
  get publicKey(): string {
    return this.props.publicKey;
  }
  get encryptedPrivateKey(): string {
    return this.props.encryptedPrivateKey;
  }
  get createdAt(): Date | undefined {
    return this.props.createdAt;
  }
  get updatedAt(): Date | undefined {
    return this.props.updatedAt;
  }
}
