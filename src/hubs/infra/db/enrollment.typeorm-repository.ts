import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import {
  DataSource,
  LessThanOrEqual,
  MoreThan,
  QueryFailedError,
} from 'typeorm';
import { ConflictError } from '../../../shared/domain/errors.js';
import { currentManager } from '../../../shared/infra/db/unit-of-work.js';
import type { Enrollment } from '../../domain/enrollment.js';
import { EnrollmentRepository } from '../../domain/enrollment.repository.js';
import { requireUnitOfWork } from './db-helpers.js';
import { EnrollmentMapper } from './enrollment.mapper.js';
import { HubEnrollmentTypeormEntity } from './hub-enrollment.entity.js';

// Tabela só do backend (sem RLS): alcançada pelo id ou pelo hash do código, nunca listada.
@Injectable()
export class EnrollmentTypeormRepository extends EnrollmentRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  private get repo() {
    return currentManager(this.dataSource).getRepository(
      HubEnrollmentTypeormEntity,
    );
  }

  async create(enrollment: Enrollment): Promise<void> {
    try {
      await this.repo.insert(EnrollmentMapper.toPersistence(enrollment));
    } catch (error) {
      const driver =
        error instanceof QueryFailedError
          ? (error.driverError as { code?: string; constraint?: string })
          : undefined;
      if (driver?.code === '23505') {
        if (driver.constraint === 'uq_hub_enrollments_key_nonce') {
          throw new ConflictError(
            'nonce-reused',
            'This nonce was already used.',
          );
        }
        if (driver.constraint === 'uq_hub_enrollments_pending_signing_key') {
          throw new ConflictError(
            'enrollment-pending-for-key',
            'Another pending enrollment has this signing key.',
          );
        }
        if (driver.constraint === 'uq_hub_enrollments_claim_code_hash') {
          throw new ConflictError(
            'claim-code-collision',
            'Another pending enrollment holds this claim code.',
          );
        }
      }
      throw error;
    }
  }

  async findById(enrollmentId: string): Promise<Enrollment | null> {
    if (!validate(enrollmentId)) return null;
    const row = await this.repo.findOne({ where: { id: enrollmentId } });
    return row ? EnrollmentMapper.toDomain(row) : null;
  }

  // Não confere a validade: quem chama usa `assertClaimable(now)`.
  async findPendingByCodeHash(codeHash: string): Promise<Enrollment | null> {
    const row = await this.repo.findOne({
      where: { claimCodeHash: codeHash, status: 'pending' },
    });
    return row ? EnrollmentMapper.toDomain(row) : null;
  }

  async lockPendingByCodeHash(codeHash: string): Promise<Enrollment | null> {
    requireUnitOfWork(
      this.dataSource,
      'EnrollmentRepository.lockPendingByCodeHash',
    );
    const row = await this.repo.findOne({
      where: { claimCodeHash: codeHash, status: 'pending' },
      lock: { mode: 'pessimistic_write' },
    });
    return row ? EnrollmentMapper.toDomain(row) : null;
  }

  // Um UPDATE condicional (pendente e dentro da validade): entre chamadas concorrentes, só uma altera a linha.
  async markClaimed(
    enrollmentId: string,
    hubId: string,
    now: Date,
  ): Promise<boolean> {
    if (!validate(enrollmentId)) return false;
    const result = await this.repo.update(
      { id: enrollmentId, status: 'pending', expiresAt: MoreThan(now) },
      { status: 'claimed', claimedHubId: hubId },
    );
    return result.affected === 1;
  }

  // Um UPDATE condicional: uma reivindicação em andamento trava a linha (FOR UPDATE); esta espera e, se a linha já
  // virou `claimed`, não a toca.
  async expirePendingOfKey(signingPublicKey: string): Promise<number> {
    const result = await this.repo.update(
      { signingPublicKey, status: 'pending' },
      { status: 'expired' },
    );
    return result.affected ?? 0;
  }

  // Lápide não: vencida vira `expired` (o runtime não tem DELETE; a limpeza física é pendência).
  async expireStale(now: Date): Promise<number> {
    const result = await this.repo.update(
      { status: 'pending', expiresAt: LessThanOrEqual(now) },
      { status: 'expired' },
    );
    return result.affected ?? 0;
  }
}
