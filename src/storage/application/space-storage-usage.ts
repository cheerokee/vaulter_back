import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { SpaceStorageUsage } from '../../spaces/application/space-storage-usage.js';
import { BackupObjectVersionRepository } from '../domain/backup-object-version.repository.js';

// Liga o uso real dos espaços na porta do `spaces` (`SpaceStorageUsage`, que o `spaces` exporta e não sabe do
// índice): soma das versões confirmadas atuais e na lixeira de 30 dias mais as reservas das intenções de envio
// (`BackupObjectVersionRepository.usedBytes`). Quem lê (redimensionar, GET do espaço) já está no escopo certo; a
// leitura entra na transação dele.
@Injectable()
export class BackupSpaceStorageUsage implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly port: SpaceStorageUsage,
    private readonly versions: BackupObjectVersionRepository,
  ) {}

  onModuleInit(): void {
    this.port.use({
      usedBytes: (organizationId, spaceId) =>
        this.versions.usedBytes(organizationId, spaceId),
    });
  }

  onModuleDestroy(): void {
    this.port.release();
  }
}
