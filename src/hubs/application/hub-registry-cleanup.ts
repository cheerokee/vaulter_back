import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { JobQueue } from '../../shared/application/job-queue.js';
import {
  HubRegistryCleanupStore,
  type HubRegistryTable,
} from './ports/hub-registry-cleanup-store.js';

/** = the window of the policies `<table>_cleanup_delete` (migration MaintenanceTrustedContexts): change both. */
export const HUB_REGISTRY_RETENTION_DAYS = 30;
export const HUB_REGISTRY_CLEANUP_BATCH = 1000;
export const HUB_REGISTRY_CLEANUP_QUEUE = 'hubs.registry-cleanup';
/** Every day at 03:15 UTC (low traffic). */
export const HUB_REGISTRY_CLEANUP_CRON = '15 3 * * *';

const TABLES: readonly HubRegistryTable[] = [
  'hub_enrollments',
  'hub_link_codes',
  'hub_auth_challenges',
];

export type HubRegistryCleanupResult = Record<HubRegistryTable, number>;

// Limpeza física das tabelas de cadastro do Hub (decisão B7): apresentações (`hub_enrollments`), códigos de vínculo
// (`hub_link_codes`) e desafios de autenticação (`hub_auth_challenges`, inclusive os falsos) vencidos há mais de 30 dias
// saem de verdade. Nenhuma delas sincroniza nem é lida depois do vencimento (a assinatura da apresentação vale só ±5 min,
// então apagar o nonce não reabre um replay). Lotes de 1000 por transação curta; idempotente; o registro leva só
// contagens.
@Injectable()
export class HubRegistryCleanup implements OnModuleInit {
  private readonly logger = new Logger(HubRegistryCleanup.name);

  constructor(
    private readonly store: HubRegistryCleanupStore,
    private readonly jobs: JobQueue,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.jobs.work(HUB_REGISTRY_CLEANUP_QUEUE, async () => {
      const result = await this.run();
      this.logger.log(`hub registry cleanup: ${JSON.stringify(result)}`);
    });
    await this.jobs.schedule(
      HUB_REGISTRY_CLEANUP_QUEUE,
      HUB_REGISTRY_CLEANUP_CRON,
    );
  }

  async run(
    batch: number = HUB_REGISTRY_CLEANUP_BATCH,
  ): Promise<HubRegistryCleanupResult> {
    const result = {} as HubRegistryCleanupResult;
    for (const table of TABLES) {
      result[table] = 0;
      for (;;) {
        const deleted = await this.store.deleteExpired(table, batch);
        result[table] += deleted;
        if (deleted < batch) break;
      }
    }
    return result;
  }
}
