import { Injectable } from '@nestjs/common';
import { normalizeEmail } from '../domain/email.js';
import type { User } from '../domain/user.js';
import { UserRepository } from '../domain/user.repository.js';

export type PublicUser = {
  id: string;
  name: string;
  email: string;
  publicKey: string;
};

// Diretório de usuários para outros módulos: só dados públicos, nunca segredo.
@Injectable()
export class UserDirectory {
  constructor(private readonly users: UserRepository) {}

  async findPublicByIds(ids: string[]): Promise<PublicUser[]> {
    if (ids.length === 0) return [];
    const users = await this.users.findByIds([...new Set(ids)]);
    return users.map(toPublic);
  }

  /** The account with this e-mail, normalized like the login (trim, NFC, lowercase); null when there is none. */
  async findPublicByEmail(email: string): Promise<PublicUser | null> {
    if (typeof email !== 'string') return null;
    const user = await this.users.findByEmail(normalizeEmail(email));
    return user ? toPublic(user) : null;
  }
}

function toPublic(u: User): PublicUser {
  return { id: u.id, name: u.name, email: u.email, publicKey: u.publicKey };
}
