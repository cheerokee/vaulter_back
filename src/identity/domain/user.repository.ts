import type { User } from './user.js';

export abstract class UserRepository {
  abstract findById(id: string): Promise<User | null>;
  abstract findByEmail(normalizedEmail: string): Promise<User | null>;
  /** Throws ConflictError('email-already-registered') on a duplicate e-mail. */
  abstract create(user: User): Promise<void>;
  abstract save(user: User): Promise<void>;
}
