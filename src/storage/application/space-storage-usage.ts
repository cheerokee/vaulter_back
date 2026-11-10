import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { SpaceStorageUsage } from '../../spaces/application/space-storage-usage.js';
import { BackupObjectVersionRepository } from '../domain/backup-object-version.repository.js';

// Registra a parte do backup no uso dos espaços (porta `SpaceStorageUsage`, que o `spaces` exporta e não sabe do
// índice; o uso é a soma das fontes registradas, o `conversations` registra a dele): soma das versões confirmadas atuais e na lixeira de 30 dias mais as reservas das intenções de envio
// (`BackupObjectVersionRepository.usedBytes`), e a parte da lixeira (`trashUsage`). Quem lê (redimensionar, GET do espaço) já está no escopo certo; a
// leitura entra na transação dele.
const BACKUP_USAGE_SOURCE = 'storage';

@Injectable()
export class BackupSpaceStorageUsage implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly port: SpaceStorageUsage,
    private readonly versions: BackupObjectVersionRepository,
  ) {}

  onModuleInit(): void {
    this.port.register(BACKUP_USAGE_SOURCE, {
      usedBytes: (organizationId, spaceId) =>
        this.versions.usedBytes(organizationId, spaceId),
      trashBytes: async (organizationId, spaceId) =>
        (await this.versions.trashUsage(organizationId, spaceId)).bytes,
    });
  }

  onModuleDestroy(): void {
    this.port.unregister(BACKUP_USAGE_SOURCE);
  }
}
