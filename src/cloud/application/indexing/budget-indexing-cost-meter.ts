import { Injectable, Logger } from '@nestjs/common';
import { AiPricing } from '../../domain/ai-pricing.js';
import {
  estimateEmbeddingTokens,
  type AiReservation,
} from '../../domain/ai-usage.js';
import { AiBudget } from '../ai-budget.js';
import { Embedder } from '../ports/embedder.js';
import {
  IndexingCostMeter,
  type IndexingCharge,
  type IndexingUsage,
  type IndexingUsageScope,
} from '../ports/indexing-cost-meter.js';
import { CloudIndexingQueue } from './cloud-indexing-queue.js';

type BudgetCharge = IndexingCharge & { reservation: AiReservation };

/** Margin after the month turns before the paused indexing retries (clocks of the API and the database may differ). */
const RESUME_MARGIN_SECONDS = 60;

// O orçamento de IA aplicado à indexação (Review Focus 3). Cada lote de embeddings reserva o custo estimado
// (`estimateEmbeddingTokens` x preço do modelo de embeddings, por cima) pelo `AiBudget`. Recusado: na MESMA transação
// que recusou, ainda sob a trava da organização, agenda uma passada do espaço para o começo do mês seguinte
// (`CloudIndexingQueue.enqueueSpaceResume`, chave própria: não adia a passada normal do espaço, que ainda precisa
// tirar arquivos apagados). O aumento do orçamento (gancho `cloud.indexing-resume`) retoma antes disso. Assim parar e
// retomar nunca se perdem: o aumento trava a mesma linha da organização e vê o arquivo ainda `pending`.
@Injectable()
export class BudgetIndexingCostMeter extends IndexingCostMeter {
  private readonly logger = new Logger(BudgetIndexingCostMeter.name);

  constructor(
    private readonly budget: AiBudget,
    private readonly pricing: AiPricing,
    private readonly embedder: Embedder,
    private readonly queue: CloudIndexingQueue,
  ) {
    super();
  }

  async reserve(
    scope: IndexingUsageScope,
    texts: readonly string[],
  ): Promise<IndexingCharge | null> {
    const estimatedMicroUsd = this.pricing.costMicroUsd(
      { inputTokens: estimateEmbeddingTokens(texts), outputTokens: 0 },
      this.embedder.model,
    );
    const outcome = await this.budget.tryReserve(
      {
        organizationId: scope.organizationId,
        spaceId: scope.spaceId,
        kind: 'indexing',
        estimatedMicroUsd,
      },
      async ({ resetsAt }) => {
        const seconds =
          Math.max(0, Math.ceil((resetsAt.getTime() - Date.now()) / 1000)) +
          RESUME_MARGIN_SECONDS;
        await this.queue.enqueueSpaceResume(
          scope.organizationId,
          scope.spaceId,
          seconds,
        );
      },
    );
    if ('refusal' in outcome) {
      // Ids and a code only.
      this.logger.log(
        {
          organizationId: scope.organizationId,
          spaceId: scope.spaceId,
          cloudFileId: scope.cloudFileId,
          reason: 'ai-budget-exceeded',
          resumesAt: outcome.refusal.resetsAt.toISOString(),
        },
        'cloud indexing paused',
      );
      return null;
    }
    const charge: BudgetCharge = {
      reservationId: outcome.reservation.id,
      reservation: outcome.reservation,
    };
    return charge;
  }

  async settle(charge: IndexingCharge, usage: IndexingUsage): Promise<void> {
    await this.budget.settle((charge as BudgetCharge).reservation, {
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: 0,
      costMicroUsd: usage.costMicroUsd,
    });
  }

  async release(charge: IndexingCharge): Promise<void> {
    await this.budget.release((charge as BudgetCharge).reservation);
  }
}
