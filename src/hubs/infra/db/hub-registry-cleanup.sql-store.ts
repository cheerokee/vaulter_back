import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { runWithContext } from '../../../shared/infra/db/unit-of-work.js';
import { HUB_REGISTRY_RETENTION_DAYS } from '../../application/hub-registry-cleanup.js';
import {
  HubRegistryCleanupStore,
  type HubRegistryTable,
} from '../../application/ports/hub-registry-cleanup-store.js';

// DELETE físico no contexto `app.hub_registry_cleanup` (migration MaintenanceTrustedContexts): a policy de DELETE só
// abre a linha vencida há mais de 30 dias; o filtro aqui repete a janela.
@Injectable()
export class HubRegistryCleanupSqlStore extends HubRegistryCleanupStore {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async deleteExpired(table: HubRegistryTable, limit: number): Promise<number> {
    // A DELETE comes back as [rows, affected count].
    const [, deleted] = await runWithContext<[unknown[], number]>(
      this.dataSource,
      { hubRegistryCleanup: 'on' },
      (m) =>
        m.query(
          `DELETE FROM "${table}" WHERE id IN (
             SELECT id FROM "${table}" WHERE expires_at < now() - make_interval(days => $1)
              ORDER BY id LIMIT $2)
           RETURNING id`,
          [HUB_REGISTRY_RETENTION_DAYS, limit],
        ),
    );
    return deleted;
  }
}
