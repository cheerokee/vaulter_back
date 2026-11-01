import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { DataSource, LessThanOrEqual } from 'typeorm';
import { currentManager } from '../../../shared/infra/db/unit-of-work.js';
import type { Enrollment } from '../../domain/enrollment.js';
import { EnrollmentRepository } from '../../domain/enrollment.repository.js';
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
    await this.repo.insert(EnrollmentMapper.toPersistence(enrollment));
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

  // Um UPDATE condicional (`status = 'pending'`): entre chamadas concorrentes, só uma altera a linha.
  async markClaimed(enrollmentId: string, hubId: string): Promise<boolean> {
    if (!validate(enrollmentId)) return false;
    const result = await this.repo.update(
      { id: enrollmentId, status: 'pending' },
      { status: 'claimed', claimedHubId: hubId },
    );
    return result.affected === 1;
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
