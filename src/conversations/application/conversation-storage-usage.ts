import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { SpaceStorageUsage } from '../../spaces/application/space-storage-usage.js';
import { ConversationSpaceUsageRepository } from '../domain/conversation-space-usage.repository.js';

const CONVERSATIONS_USAGE_SOURCE = 'conversations';

// Registra a parte dos assuntos no uso dos espaços (porta `SpaceStorageUsage` do `spaces`, a soma das fontes; o
// `storage` registra a do backup): os corpos cifrados das mensagens ainda guardados, e a parte deles com lápide como
// lixeira (spec conversations §4.4.1). Assim o tamanho do espaço, o redimensionar e a intenção de envio do backup
// contam as mensagens, e o envio de mensagem conta o backup, pela mesma regra (`space-storage-full`).
@Injectable()
export class ConversationStorageUsage implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly port: SpaceStorageUsage,
    private readonly usage: ConversationSpaceUsageRepository,
  ) {}

  onModuleInit(): void {
    this.port.register(CONVERSATIONS_USAGE_SOURCE, {
      usedBytes: async (organizationId, spaceId) =>
        (await this.usage.totals(organizationId, spaceId)).bodyBytes,
      trashBytes: async (organizationId, spaceId) =>
        (await this.usage.totals(organizationId, spaceId)).trashBytes,
    });
  }

  onModuleDestroy(): void {
    this.port.unregister(CONVERSATIONS_USAGE_SOURCE);
  }
}
