import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { assertHubStorageCapacity } from '../domain/hub-storage.js';
import { HubRepository } from '../domain/hub.repository.js';
import type { HubAuthContext } from './authenticate-hub-token.use-case.js';
import { hubNotFound } from './hub-errors.js';

// O Hub informa a capacidade utilizável do SSD (`PUT /hub/storage`, token de Hub; spec storage-backup §4.5): na
// autenticação e quando mudar. Grava só a coluna, no contexto do próprio Hub. Menor que o já reservado (SSD trocado)
// é aceito: só as próximas instalações são recusadas. O UPDATE trava a linha do Hub (o mesmo lock das instalações),
// então uma instalação em curso termina com a capacidade antiga e a seguinte já vê a nova. Não é auditado (o
// aparelho informa a cada autenticação).
@Injectable()
export class ReportHubStorageUseCase {
  constructor(
    private readonly hubs: HubRepository,
    private readonly uow: UnitOfWork,
  ) {}

  execute(
    hub: HubAuthContext,
    input: { capacityBytes: number },
  ): Promise<void> {
    const bytes = assertHubStorageCapacity(input.capacityBytes);
    return this.uow.run(async () => {
      await this.uow.setContext({ hubId: hub.hubId });
      if (!(await this.hubs.setStorageCapacity(hub.hubId, bytes))) {
        throw hubNotFound();
      }
    });
  }
}
