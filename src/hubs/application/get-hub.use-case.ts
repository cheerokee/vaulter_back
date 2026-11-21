import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import { HubSpaceRepository } from '../domain/hub-space.repository.js';
import { toHubWithRoleView, type HubWithRoleView } from './dto/hub-view.js';
import { HubAccess } from './hub-access.js';
import { hubNotFound } from './hub-errors.js';
import { PcKeyAudience, type HubKeyView } from './ports/pc-key-audience.js';

// Detalhes do Hub (`GET /hubs/:id`): o dono e quem o vê por uma organização vinculada; os outros, 404. Com a
// capacidade informada pelo Hub e o reservado pelos espaços instalados que quem consulta vê (como em
// `GET /hubs/:id/spaces`): o dono, todos; os outros, os das organizações de que são membros ativos.
// Hub `pc` de outra pessoa: `HubAccess` não o mostra, mas a chave pública dele é de quem precisa cifrar cópias para ele
// (membro de um espaço em que o `pc` tem Sala, participante de um assunto que ele executa): para esses, só a visão de
// chave (`HubKeyView`: id, nome, kind e chave pública; sem papel nem campos de dono). Toda outra rota segue 404.
@Injectable()
export class GetHubUseCase {
  constructor(
    private readonly access: HubAccess,
    private readonly directory: OrganizationDirectory,
    private readonly hubSpaces: HubSpaceRepository,
    private readonly pcKeys: PcKeyAudience,
  ) {}

  async execute(
    actor: Actor,
    hubId: string,
  ): Promise<HubWithRoleView | HubKeyView> {
    const grant = await this.access.find(hubId, actor.userId);
    if (!grant) {
      const keyView = await this.pcKeys.findKeyView(hubId, actor.userId);
      if (!keyView) throw hubNotFound();
      return keyView;
    }
    const { hub, role } = grant;
    const reservedBytes =
      role === 'hub_owner'
        ? await this.hubSpaces.reservedBytes(hub.id)
        : await this.hubSpaces.reservedBytes(
            hub.id,
            await this.directory.organizationIdsOf(actor.userId),
          );
    return {
      ...toHubWithRoleView(hub, role),
      storage: { capacityBytes: hub.storageCapacityBytes, reservedBytes },
    };
  }
}
