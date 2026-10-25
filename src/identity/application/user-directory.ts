import { Injectable } from '@nestjs/common';
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
    return users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      publicKey: u.publicKey,
    }));
  }
}
