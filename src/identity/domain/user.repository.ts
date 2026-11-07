import type { User } from './user.js';

export abstract class UserRepository {
  abstract findById(id: string): Promise<User | null>;
  /** Missing ids are skipped; order is not guaranteed. */
  abstract findByIds(ids: string[]): Promise<User[]>;
  abstract findByEmail(normalizedEmail: string): Promise<User | null>;
  /** Throws ConflictError('email-already-registered') on a duplicate e-mail. */
  abstract create(user: User): Promise<void>;
  /** SELECT ... FOR UPDATE: only meaningful inside a unit of work. */
  abstract findByIdForUpdate(id: string): Promise<User | null>;
  /** Writes only auth_hash, kdf_salt, kdf_params and encrypted_private_key. */
  abstract updatePasswordMaterial(user: User): Promise<void>;
  /** Writes only recovery_hash and recovery_encrypted_private_key. */
  abstract updateRecoveryCode(user: User): Promise<void>;
}
