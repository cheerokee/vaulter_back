import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ConflictError } from '../../../shared/domain/errors.js';
import type { User } from '../../domain/user.js';
import { UserRepository } from '../../domain/user.repository.js';
import { UserTypeormEntity } from './user.entity.js';
import { UserMapper } from './user.mapper.js';

const UNIQUE_VIOLATION = '23505';

@Injectable()
export class UserTypeormRepository extends UserRepository {
  constructor(
    @InjectRepository(UserTypeormEntity)
    private readonly repo: Repository<UserTypeormEntity>,
  ) {
    super();
  }

  async findById(id: string): Promise<User | null> {
    const row = await this.repo.findOne({ where: { id } });
    return row ? UserMapper.toDomain(row) : null;
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

  async save(user: User): Promise<void> {
    const {
      id,
      createdAt: _createdAt,
      ...rest
    } = UserMapper.toPersistence(user);
    await this.repo.update({ id }, rest);
  }
}
