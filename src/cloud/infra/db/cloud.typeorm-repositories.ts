import { Injectable } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import { currentManager } from '../../../shared/infra/db/unit-of-work.js';
import type {
  CloudTerm,
  CloudTermAcceptance,
} from '../../domain/cloud-term.js';
import {
  CloudTermAcceptanceRepository,
  CloudTermRepository,
  ServerKeyGrantRepository,
  SpaceActivationRepository,
} from '../../domain/cloud.repositories.js';
import { SpaceActivation } from '../../domain/space-activation.js';
import { CloudTermAcceptanceTypeormEntity } from './cloud-term-acceptance.entity.js';
import { CloudTermTypeormEntity } from './cloud-term.entity.js';
import { ServerKeyGrantTypeormEntity } from './server-key-grant.entity.js';
import { SpaceActivationTypeormEntity } from './space-activation.entity.js';

function requireUnitOfWork(dataSource: DataSource, method: string): void {
  if (!currentManager(dataSource).queryRunner?.isTransactionActive) {
    throw new Error(
      `${method} requires an active unit of work (call it inside UnitOfWork.run).`,
    );
  }
}

// Termos: dado do servidor, sem RLS (só leitura para o runtime).
@Injectable()
export class CloudTermTypeormRepository extends CloudTermRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async current(): Promise<CloudTerm | null> {
    const row = await currentManager(this.dataSource)
      .getRepository(CloudTermTypeormEntity)
      .findOne({ where: {}, order: { version: 'DESC' } });
    return row
      ? {
          version: row.version,
          hash: row.hash,
          text: row.text,
          publishedAt: row.publishedAt,
        }
      : null;
  }
}

const toAcceptance = (
  row: CloudTermAcceptanceTypeormEntity,
): CloudTermAcceptance => ({
  organizationId: row.organizationId,
  termVersion: row.termVersion,
  termHash: row.termHash,
  acceptedByUserId: row.acceptedByUserId,
  acceptedAt: row.acceptedAt,
});

@Injectable()
export class CloudTermAcceptanceTypeormRepository extends CloudTermAcceptanceRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async latest(orgId: string): Promise<CloudTermAcceptance | null> {
    const row = await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m.getRepository(CloudTermAcceptanceTypeormEntity).findOne({
        where: { organizationId: orgId },
        order: { termVersion: 'DESC' },
      }),
    );
    return row ? toAcceptance(row) : null;
  }

  // ON CONFLICT DO NOTHING: dois aceites concorrentes da mesma versão gravam uma linha só; o que perde lê a do outro.
  async acceptOnce(
    a: CloudTermAcceptance & { ip: string | null },
  ): Promise<{ acceptance: CloudTermAcceptance; created: boolean }> {
    return runInOrganizationScope(
      this.dataSource,
      a.organizationId,
      async (m) => {
        const inserted: unknown[] = await m.query(
          `INSERT INTO cloud_term_acceptances
             (organization_id, term_version, term_hash, accepted_by_user_id, accepted_at, ip)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (organization_id, term_version) DO NOTHING
           RETURNING id`,
          [
            a.organizationId,
            a.termVersion,
            a.termHash,
            a.acceptedByUserId,
            a.acceptedAt,
            a.ip,
          ],
        );
        const row = await m
          .getRepository(CloudTermAcceptanceTypeormEntity)
          .findOneOrFail({
            where: {
              organizationId: a.organizationId,
              termVersion: a.termVersion,
            },
          });
        return { acceptance: toAcceptance(row), created: inserted.length > 0 };
      },
    );
  }
}

const toActivation = (row: SpaceActivationTypeormEntity): SpaceActivation =>
  SpaceActivation.restore(
    {
      organizationId: row.organizationId,
      spaceId: row.spaceId,
      state: row.state,
      termVersion: row.termVersion,
      authorizedByUserId: row.authorizedByUserId,
      authorizedAt: row.authorizedAt,
      activatedByUserId: row.activatedByUserId,
      activatedAt: row.activatedAt,
    },
    row.id,
  );

@Injectable()
export class SpaceActivationTypeormRepository extends SpaceActivationRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async findLive(
    orgId: string,
    spaceId: string,
  ): Promise<SpaceActivation | null> {
    const row = await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m.getRepository(SpaceActivationTypeormEntity).findOne({
        where: { organizationId: orgId, spaceId, deletedAt: IsNull() },
      }),
    );
    return row ? toActivation(row) : null;
  }

  async lockLive(
    orgId: string,
    spaceId: string,
  ): Promise<SpaceActivation | null> {
    requireUnitOfWork(this.dataSource, 'SpaceActivationRepository.lockLive');
    const row = await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m.getRepository(SpaceActivationTypeormEntity).findOne({
        where: { organizationId: orgId, spaceId, deletedAt: IsNull() },
        lock: { mode: 'pessimistic_write' },
      }),
    );
    return row ? toActivation(row) : null;
  }

  async insert(a: SpaceActivation): Promise<void> {
    await runInOrganizationScope(this.dataSource, a.organizationId, (m) =>
      m.getRepository(SpaceActivationTypeormEntity).insert({
        id: a.id,
        organizationId: a.organizationId,
        spaceId: a.spaceId,
        state: a.state,
        termVersion: a.termVersion,
        authorizedByUserId: a.authorizedByUserId,
        authorizedAt: a.authorizedAt,
        activatedByUserId: a.activatedByUserId,
        activatedAt: a.activatedAt,
      }),
    );
  }

  async save(a: SpaceActivation): Promise<void> {
    await runInOrganizationScope(this.dataSource, a.organizationId, (m) =>
      m.getRepository(SpaceActivationTypeormEntity).update(
        { id: a.id, organizationId: a.organizationId },
        {
          state: a.state,
          activatedByUserId: a.activatedByUserId,
          activatedAt: a.activatedAt,
        },
      ),
    );
  }

  async end(a: SpaceActivation, byUserId: string, at: Date): Promise<void> {
    await runInOrganizationScope(this.dataSource, a.organizationId, (m) =>
      m
        .getRepository(SpaceActivationTypeormEntity)
        .update(
          { id: a.id, organizationId: a.organizationId, deletedAt: IsNull() },
          { deletedAt: at, deactivatedByUserId: byUserId },
        ),
    );
  }
}

@Injectable()
export class ServerKeyGrantTypeormRepository extends ServerKeyGrantRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async insert(g: {
    organizationId: string;
    spaceId: string;
    spaceKeyId: string;
    keyVersion: number;
    wrappedKey: string;
  }): Promise<void> {
    await runInOrganizationScope(this.dataSource, g.organizationId, (m) =>
      m.getRepository(ServerKeyGrantTypeormEntity).insert(g),
    );
  }

  async findForSpace(
    orgId: string,
    spaceId: string,
  ): Promise<{ keyVersion: number; wrappedKey: string }[]> {
    const rows = await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m.getRepository(ServerKeyGrantTypeormEntity).find({
        where: { organizationId: orgId, spaceId },
        order: { keyVersion: 'ASC' },
      }),
    );
    return rows.map((r) => ({
      keyVersion: r.keyVersion,
      wrappedKey: r.wrappedKey,
    }));
  }

  async deleteForSpace(orgId: string, spaceId: string): Promise<number> {
    const result = await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m
        .getRepository(ServerKeyGrantTypeormEntity)
        .delete({ organizationId: orgId, spaceId }),
    );
    return result.affected ?? 0;
  }
}
