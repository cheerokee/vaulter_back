import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { SpacesModule } from '../spaces/spaces.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { BackupPlaintextReader } from './application/indexing/backup-plaintext-reader.js';
import { CloudIndexingQueue } from './application/indexing/cloud-indexing-queue.js';
import { CloudIndexingWorkers } from './application/indexing/cloud-indexing.workers.js';
import { IndexFileJob } from './application/indexing/index-file.job.js';
import { IndexSpaceJob } from './application/indexing/index-space.job.js';
import { SpaceKeyOpener } from './application/indexing/space-keys.js';
import { BackupObjectOpener } from './application/ports/backup-object-opener.js';
import { IndexingCostMeter } from './application/ports/indexing-cost-meter.js';
import { AiBudget } from './application/ai-budget.js';
import { GetAiUsageUseCase } from './application/ai-usage.use-case.js';
import { CloudAiBudgetHooks } from './application/cloud-ai-budget.hooks.js';
import { BudgetIndexingCostMeter } from './application/indexing/budget-indexing-cost-meter.js';
import { AiUsageLedger } from './domain/ai-usage.repository.js';
import { AiReservationTypeormEntity } from './infra/db/ai-reservation.entity.js';
import { AiUsageTypeormEntity } from './infra/db/ai-usage.entity.js';
import { AiUsageSqlLedger } from './infra/db/ai-usage.sql-repository.js';
import { AiUsageController } from './infra/http/ai-usage.controller.js';
import { TextExtractor } from './application/ports/text-extractor.js';
import {
  CloudChunkRepository,
  CloudFileRepository,
} from './domain/indexing.repositories.js';
import { CloudChunkTypeormEntity } from './infra/db/cloud-chunk.entity.js';
import { CloudFileTypeormEntity } from './infra/db/cloud-file.entity.js';
import {
  CloudChunkSqlRepository,
  CloudFileTypeormRepository,
} from './infra/db/cloud-index.typeorm-repositories.js';
import { SodiumBackupObjectOpener } from './infra/crypto/sodium-backup-object-opener.js';
import { WorkerTextExtractor } from './infra/extraction/worker-text-extractor.js';
import { CloudKeyRotatedHook } from './application/cloud-key-rotated.hook.js';
import { CloudServerCopyCheck } from './application/cloud-server-copy-check.js';
import { CloudSpaceAccess } from './application/cloud-space-access.js';
import { CloudSpaceJobs } from './application/cloud-space-jobs.js';
import {
  AcceptCloudTermsUseCase,
  GetCloudTermsUseCase,
} from './application/cloud-terms.use-cases.js';
import {
  ActivateSpaceCloudUseCase,
  AuthorizeSpaceCloudUseCase,
  DeactivateSpaceCloudUseCase,
  GetSpaceCloudUseCase,
} from './application/space-cloud.use-cases.js';
import {
  CloudTermAcceptanceRepository,
  CloudTermRepository,
  ServerKeyGrantRepository,
  SpaceActivationRepository,
} from './domain/cloud.repositories.js';
import { CloudTermAcceptanceTypeormEntity } from './infra/db/cloud-term-acceptance.entity.js';
import { CloudTermTypeormEntity } from './infra/db/cloud-term.entity.js';
import {
  CloudTermAcceptanceTypeormRepository,
  CloudTermTypeormRepository,
  ServerKeyGrantTypeormRepository,
  SpaceActivationTypeormRepository,
} from './infra/db/cloud.typeorm-repositories.js';
import { ServerKeyGrantTypeormEntity } from './infra/db/server-key-grant.entity.js';
import { SpaceActivationTypeormEntity } from './infra/db/space-activation.entity.js';
import { CloudTermsController } from './infra/http/cloud-terms.controller.js';
import { SpaceCloudController } from './infra/http/space-cloud.controller.js';
import { Embedder } from './application/ports/embedder.js';
import { LanguageModel } from './application/ports/language-model.js';
import { ServerKeyring } from './application/ports/server-keyring.js';
import { AiPricing } from './domain/ai-pricing.js';
import { BedrockLanguageModel } from './infra/bedrock/bedrock-language-model.js';
import { OllamaEmbedder } from './infra/embeddings/ollama-embedder.js';
import { FakeLanguageModel } from './testing/fake-language-model.js';
import { KmsKeyEnvelope } from './infra/crypto/kms-key-envelope.js';
import { KmsServerKeyring } from './infra/crypto/kms-server-keyring.js';
import { CloudServerKeyTypeormEntity } from './infra/db/server-key.entity.js';
import { ServerKeyTypeormStore } from './infra/db/server-key.store.js';
import {
  CloudServerKeyController,
  HubCloudServerKeyController,
} from './infra/http/cloud-server-key.controller.js';

export function createLanguageModel(config: ConfigService): LanguageModel {
  if (config.get<string>('CLOUD_LLM_DRIVER') !== 'fake') {
    return new BedrockLanguageModel(config);
  }
  // Second line of defense (env validation refuses it first): canned answers never reach real customers.
  if (config.get<string>('NODE_ENV') === 'production') {
    throw new Error('CLOUD_LLM_DRIVER=fake is not allowed in production');
  }
  return new FakeLanguageModel();
}

/**
 * Active cloud (spec 2026-11-10-active-cloud-design): the cloud reads a space only when it is in `active_cloud`.
 * Depends on the other modules only through what they export; no module imports `cloud`. Task 1: the server key
 * (KMS envelope) and its public route; the job queue is the global `JobQueue` (src/shared/infra/jobs). Task 3: the term
 * and its acceptance, authorizing / switching on / switching off a space, and the server copy on key rotations
 * (`SpaceKeyRotatedHooks`). Task 4: indexing from the encrypted backup (manifests, extraction, chunks + pgvector),
 * through `storage`'s `BackupContentReader` and `BackupObjectsChangedHooks`. Task 5: the monthly AI budget (`AiBudget`:
 * reserve -> call -> settle/release; usage ledger; `GET /organizations/:id/ai-usage`; indexing pauses/resumes).
 */
@Module({
  imports: [
    // Uma direção só: o cloud usa o que spaces e organizations exportam; ninguém importa o cloud.
    OrganizationsModule,
    SpacesModule,
    StorageModule,
    TypeOrmModule.forFeature([
      CloudServerKeyTypeormEntity,
      CloudTermTypeormEntity,
      CloudTermAcceptanceTypeormEntity,
      SpaceActivationTypeormEntity,
      ServerKeyGrantTypeormEntity,
      CloudFileTypeormEntity,
      CloudChunkTypeormEntity,
      AiReservationTypeormEntity,
      AiUsageTypeormEntity,
    ]),
  ],
  controllers: [
    CloudServerKeyController,
    HubCloudServerKeyController,
    CloudTermsController,
    SpaceCloudController,
    AiUsageController,
  ],
  providers: [
    { provide: CloudTermRepository, useClass: CloudTermTypeormRepository },
    {
      provide: CloudTermAcceptanceRepository,
      useClass: CloudTermAcceptanceTypeormRepository,
    },
    {
      provide: SpaceActivationRepository,
      useClass: SpaceActivationTypeormRepository,
    },
    {
      provide: ServerKeyGrantRepository,
      useClass: ServerKeyGrantTypeormRepository,
    },
    CloudSpaceAccess,
    CloudSpaceJobs,
    CloudKeyRotatedHook,
    CloudServerCopyCheck,
    GetCloudTermsUseCase,
    AcceptCloudTermsUseCase,
    GetSpaceCloudUseCase,
    AuthorizeSpaceCloudUseCase,
    ActivateSpaceCloudUseCase,
    DeactivateSpaceCloudUseCase,
    { provide: CloudFileRepository, useClass: CloudFileTypeormRepository },
    { provide: CloudChunkRepository, useClass: CloudChunkSqlRepository },
    { provide: BackupObjectOpener, useClass: SodiumBackupObjectOpener },
    { provide: TextExtractor, useClass: WorkerTextExtractor },
    // Orçamento de IA (Task 5): cada lote de embeddings reserva no orçamento e acerta o gasto real.
    { provide: IndexingCostMeter, useClass: BudgetIndexingCostMeter },
    { provide: AiUsageLedger, useClass: AiUsageSqlLedger },
    AiBudget,
    GetAiUsageUseCase,
    CloudAiBudgetHooks,
    CloudIndexingQueue,
    SpaceKeyOpener,
    BackupPlaintextReader,
    IndexSpaceJob,
    IndexFileJob,
    CloudIndexingWorkers,
    KmsKeyEnvelope,
    ServerKeyTypeormStore,
    { provide: ServerKeyring, useClass: KmsServerKeyring },
    { provide: Embedder, useClass: OllamaEmbedder },
    {
      // Driver chosen by CLOUD_LLM_DRIVER: `fake` only for development without Bedrock (e2e override by DI).
      provide: LanguageModel,
      inject: [ConfigService],
      useFactory: createLanguageModel,
    },
    {
      // Boot check: every model we may call has a price (an unpriced one would fail only after a billed call).
      provide: AiPricing,
      inject: [ConfigService, LanguageModel],
      useFactory: (config: ConfigService, llm: LanguageModel): AiPricing => {
        const pricing = new AiPricing();
        pricing.assertPriced(
          llm.model,
          config.getOrThrow<string>('EMBEDDING_MODEL'),
        );
        return pricing;
      },
    },
  ],
})
export class CloudModule {}
