import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServerKeyring } from './application/ports/server-keyring.js';
import { KmsKeyEnvelope } from './infra/crypto/kms-key-envelope.js';
import { KmsServerKeyring } from './infra/crypto/kms-server-keyring.js';
import { CloudServerKeyTypeormEntity } from './infra/db/server-key.entity.js';
import { ServerKeyTypeormStore } from './infra/db/server-key.store.js';
import { CloudServerKeyController } from './infra/http/cloud-server-key.controller.js';

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
  ],
})
export class CloudModule {}
