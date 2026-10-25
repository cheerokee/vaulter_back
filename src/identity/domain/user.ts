import { DomainValidationError } from '../../shared/domain/errors.js';
import { Entity } from '../../shared/domain/entity.js';
import {
  assertEncryptedPrivateKey,
  assertKdfSalt,
  assertPublicKey,
} from './crypto-material.js';
import { normalizeEmail } from './email.js';
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
  static register(input: {
    name: string;
    email: string;
    authHash: string;
    kdfSalt: string;
    kdfParams: unknown;
    publicKey: string;
    encryptedPrivateKey: string;
  }): User {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length < 1 || name.length > 255) {
      throw new DomainValidationError(
        'user-name-invalid',
        'The name must have between 1 and 255 characters.',
      );
    }
    return new User({
      name,
      email: normalizeEmail(input.email),
      authHash: assertAuthHash(input.authHash),
      kdfSalt: assertKdfSalt(input.kdfSalt),
      kdfParams: parseKdfParams(input.kdfParams),
      publicKey: assertPublicKey(input.publicKey),
      encryptedPrivateKey: assertEncryptedPrivateKey(input.encryptedPrivateKey),
    });
  }

  static restore(props: UserProps, id: string): User {
    return new User(props, id);
  }

  changePassword(input: {
    authHash: string;
    kdfSalt: string;
    kdfParams: unknown;
    encryptedPrivateKey: string;
  }): void {
    const authHash = assertAuthHash(input.authHash);
    const kdfSalt = assertKdfSalt(input.kdfSalt);
    const kdfParams = parseKdfParams(input.kdfParams);
    const encryptedPrivateKey = assertEncryptedPrivateKey(
      input.encryptedPrivateKey,
    );
    this.props = {
      ...this.props,
      authHash,
      kdfSalt,
      kdfParams,
      encryptedPrivateKey,
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
