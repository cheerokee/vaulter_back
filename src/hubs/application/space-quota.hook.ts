import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  SpaceQuotaHooks,
  type SpaceQuotaContext,
  type SpaceQuotaIncrease,
} from '../../shared/application/space-quota-hooks.js';
import { assertHubCapacityFits } from '../domain/hub-storage.js';
import { HubSpaceRepository } from '../domain/hub-space.repository.js';
import { HubRepository } from '../domain/hub.repository.js';

const HOOK_NAME = 'hubs.space-quota';

// Aumentar um espaço precisa caber em cada Hub onde ele está instalado (spec storage-backup §4.4). Ordem dos locks:
// os Hubs vêm ANTES do espaço (Hub -> vínculo -> hub_space -> espaço), então:
// - `lock` (antes do espaço): trava, em ordem de id, os Hubs onde o espaço está (FOR NO KEY UPDATE, o mesmo lock da
//   instalação), esperando quem estiver instalando neles;
// - `assertIncrease` (com o espaço travado): relê os Hubs. Uma instalação que confirmou entre a primeira leitura e o
//   lock do espaço aparece agora e ainda não está travada: trava com NOWAIT (409 `hub-storage-busy` se outro a
//   segura; esperar aqui inverteria a ordem). Uma instalação ainda em curso espera o lock do espaço (FOR SHARE) e
//   confere a capacidade com o tamanho novo. Depois, com todos os Hubs travados, confere cada capacidade.
@Injectable()
export class HubsSpaceQuotaHook implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly hooks: SpaceQuotaHooks,
    private readonly hubs: HubRepository,
    private readonly hubSpaces: HubSpaceRepository,
  ) {}

  onModuleInit(): void {
    this.hooks.register({
      name: HOOK_NAME,
      lock: (ctx) => this.lock(ctx),
      assertIncrease: (ctx) => this.assertIncrease(ctx),
    });
  }

  onModuleDestroy(): void {
    this.hooks.unregister(HOOK_NAME);
  }

  async lock(ctx: SpaceQuotaContext): Promise<void> {
    for (const hubId of await this.hubSpaces.hubIdsOfSpace(
      ctx.organizationId,
      ctx.spaceId,
    )) {
      await this.hubs.lockForStorage(hubId);
    }
  }

  async assertIncrease(ctx: SpaceQuotaIncrease): Promise<void> {
    const extra = ctx.toBytes - ctx.fromBytes;
    for (const hubId of await this.hubSpaces.hubIdsOfSpace(
      ctx.organizationId,
      ctx.spaceId,
    )) {
      // Já travado por `lock` = imediato (o lock é desta transação); um Hub novo, NOWAIT.
      const hub = await this.hubs.lockForStorage(hubId, { nowait: true });
      // Desregistrado (o hub_space cai junto) ou sem capacidade informada: nada a conferir.
      if (!hub || hub.storageCapacityBytes === null) continue;
      assertHubCapacityFits(
        {
          capacityBytes: hub.storageCapacityBytes,
          reservedBytes: await this.hubSpaces.reservedBytes(hubId),
        },
        extra,
        // Os bytes somam todas as organizações do Hub: só o dono os vê; os outros recebem só o `hubId`.
        { hubId, showBytes: hub.ownerUserId === ctx.actorUserId },
      );
    }
  }
}
