import { Injectable } from '@nestjs/common';
import { DataSource, In, QueryFailedError, type Repository } from 'typeorm';
import { ConflictError } from '../../../shared/domain/errors.js';
import { currentManager } from '../../../shared/infra/db/unit-of-work.js';
import type { User } from '../../domain/user.js';
import { UserRepository } from '../../domain/user.repository.js';
import { UserTypeormEntity } from './user.entity.js';
import { UserMapper } from './user.mapper.js';

const UNIQUE_VIOLATION = '23505';

@Injectable()
export class UserTypeormRepository extends UserRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  // Resolvido a cada operação: dentro de um UnitOfWork.run, usa a transação ativa.
  private get repo(): Repository<UserTypeormEntity> {
    return currentManager(this.dataSource).getRepository(UserTypeormEntity);
  }

  async findById(id: string): Promise<User | null> {
    const row = await this.repo.findOne({ where: { id } });
    return row ? UserMapper.toDomain(row) : null;
  }

  async findByIds(ids: string[]): Promise<User[]> {
    if (ids.length === 0) return [];
    const rows = await this.repo.find({ where: { id: In(ids) } });
    return rows.map((row) => UserMapper.toDomain(row));
  }

  async findByEmail(normalizedEmail: string): Promise<User | null> {
    const row = await this.repo.findOne({ where: { email: normalizedEmail } });
    return row ? UserMapper.toDomain(row) : null;
  }

  async create(user: User): Promise<void> {
    try {
      await this.repo.insert(UserMapper.toPersistence(user));
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string; constraint?: string }).code ===
          UNIQUE_VIOLATION &&
        (error.driverError as { constraint?: string }).constraint ===
          'uq_users_email'
      ) {
        throw new ConflictError(
          'email-already-registered',
          'This e-mail is already registered.',
        );
      }
      throw error;
    }
  }

  async findByIdForUpdate(id: string): Promise<User | null> {
    const row = await this.repo.findOne({
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    return row ? UserMapper.toDomain(row) : null;
  }

  // Escrita por campo: dois fluxos concorrentes (troca de senha e troca do código) nunca sobrescrevem um o outro.
  async updatePasswordMaterial(user: User): Promise<void> {
    await this.repo.update(
      { id: user.id },
      {
        authHash: user.authHash,
        kdfSalt: user.kdfSalt,
        kdfParams: user.kdfParams,
        encryptedPrivateKey: user.encryptedPrivateKey,
      },
    );
  }

  async updateRecoveryCode(user: User): Promise<void> {
    await this.repo.update(
      { id: user.id },
      {
        recoveryHash: user.recoveryHash,
        recoveryEncryptedPrivateKey: user.recoveryEncryptedPrivateKey,
      },
    );
  }
}
