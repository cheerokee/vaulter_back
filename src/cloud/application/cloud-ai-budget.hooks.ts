import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { OrganizationAiSpend } from '../../organizations/application/organization-ai-spend.js';
import {
  AiBudgetRaisedHooks,
  type AiBudgetRaisedContext,
} from '../../shared/application/ai-budget-raised-hooks.js';
import { CloudFileRepository } from '../domain/indexing.repositories.js';
import { AiBudget } from './ai-budget.js';
import { CloudIndexingQueue } from './indexing/cloud-indexing-queue.js';

export const AI_BUDGET_RESUME_HOOK = 'cloud.indexing-resume';

// O `cloud` liga o orçamento de IA aos outros módulos sem que eles o importem:
// - registra a fonte do gasto do mês em `OrganizationAiSpend` (o `GET /organizations/:id` mostra o nível de aviso);
// - assina `AiBudgetRaisedHooks`: quando o financeiro AUMENTA o orçamento, enfileira na hora (na mesma transação, com
//   a organização travada) a passada de cada espaço com arquivo ainda `pending`, que reenfileira os arquivos parados
//   pelo orçamento (Review Focus 3). Só lê `cloud_files` e enfileira: não trava nada depois da organização.
@Injectable()
export class CloudAiBudgetHooks implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly spend: OrganizationAiSpend,
    private readonly raised: AiBudgetRaisedHooks,
    private readonly budget: AiBudget,
    private readonly files: CloudFileRepository,
    private readonly queue: CloudIndexingQueue,
  ) {}

  onModuleInit(): void {
    this.spend.register({
      consumedMicroUsd: (orgId) => this.budget.consumedMicroUsd(orgId),
    });
    this.raised.register({
      name: AI_BUDGET_RESUME_HOOK,
      onAiBudgetRaised: (ctx) => this.resumeIndexing(ctx),
    });
  }

  onModuleDestroy(): void {
    this.spend.unregister();
    this.raised.unregister(AI_BUDGET_RESUME_HOOK);
  }

  private async resumeIndexing(ctx: AiBudgetRaisedContext): Promise<void> {
    const spaceIds = await this.files.spacesWithPending(ctx.organizationId);
    for (const spaceId of spaceIds) {
      await this.queue.enqueueSpace(ctx.organizationId, spaceId, {
        debounce: false,
      });
    }
  }
}
