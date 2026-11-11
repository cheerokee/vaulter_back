import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
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
import { CloudServerKeyController } from './infra/http/cloud-server-key.controller.js';

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
 * (KMS envelope) and its public route; the job queue is the global `JobQueue` (src/shared/infra/jobs).
 */
@Module({
  imports: [TypeOrmModule.forFeature([CloudServerKeyTypeormEntity])],
  controllers: [CloudServerKeyController],
  providers: [
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
