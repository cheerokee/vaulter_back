import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  SpaceMemberLeftHooks,
  type SpaceMemberLeftContext,
} from '../../shared/application/space-member-left-hooks.js';
import { SpaceRoomService } from '../../spaces/application/space-room.service.js';
import { HubOrganizationRepository } from '../domain/hub-organization.repository.js';

const HOOK_NAME = 'hubs.space-member-left';

// Dono do Hub sai (ou é tirado) de um espaço (spec §6): a liberação desse espaço na Sala dos Hubs dele CAI (o
// aparelho de quem não está mais no espaço não pode continuar com a chave); o hub_space continua. Roda dentro da
// transação da saída, com o espaço JÁ travado pelo `spaces`: aqui só se LÊ (os vínculos da organização cujos Hubs são
// dessa pessoa, pela cópia `hub_owner_user_id`, sem lock nenhum: travar um vínculo agora inverteria a ordem
// vínculo -> espaço). `revokeRoom` `trusted` trava de novo o mesmo espaço (já é desta transação) e devolve false
// quando o Hub não estava na Sala. Erro desfaz a saída.
@Injectable()
export class HubsSpaceMemberLeftHook implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly hooks: SpaceMemberLeftHooks,
    private readonly links: HubOrganizationRepository,
    private readonly room: SpaceRoomService,
  ) {}

  onModuleInit(): void {
    this.hooks.register({
      name: HOOK_NAME,
      onSpaceMemberLeft: (ctx) => this.onSpaceMemberLeft(ctx),
    });
  }

  onModuleDestroy(): void {
    this.hooks.unregister(HOOK_NAME);
  }

  async onSpaceMemberLeft(ctx: SpaceMemberLeftContext): Promise<void> {
    const { organizationId, spaceId, userId } = ctx;
    const owned = await this.links.listOwnedInOrganization(
      organizationId,
      userId,
    );
    for (const { hubId } of owned) {
      await this.room.revokeRoom(
        { kind: 'trusted', organizationId, actorId: null },
        { hubId, spaceId, reason: 'owner_left_space' },
      );
    }
  }
}
