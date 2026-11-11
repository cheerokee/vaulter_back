import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  SpaceKeyRotatedHooks,
  type SpaceKeyRotatedContext,
} from '../../shared/application/space-key-rotated-hooks.js';
import { ServerKeyGrantRepository } from '../domain/cloud.repositories.js';
import { ServerKeyring } from './ports/server-keyring.js';
import { assertOpensWithServerKey } from './server-copy.js';

const NAME = 'cloud.server-copy';

// Troca de chave de um espaço em nuvem ativa (o `spaces` exige a cópia para o servidor e a entrega aqui, na mesma
// transação, com o espaço travado FOR UPDATE): confere que a cópia abre com a chave do servidor (422
// `server-copy-invalid` desfaz a troca inteira) e a guarda em `cloud_space_key_grants`.
@Injectable()
export class CloudKeyRotatedHook implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly hooks: SpaceKeyRotatedHooks,
    private readonly keyring: ServerKeyring,
    private readonly grants: ServerKeyGrantRepository,
  ) {}

  onModuleInit(): void {
    this.hooks.register({
      name: NAME,
      onSpaceKeyRotated: (ctx) => this.onRotated(ctx),
    });
  }

  onModuleDestroy(): void {
    this.hooks.unregister(NAME);
  }

  async onRotated(ctx: SpaceKeyRotatedContext): Promise<void> {
    if (ctx.serverWrappedKey === null) return;
    await assertOpensWithServerKey(this.keyring, ctx.serverWrappedKey);
    await this.grants.insert({
      organizationId: ctx.organizationId,
      spaceId: ctx.spaceId,
      spaceKeyId: ctx.spaceKeyId,
      keyVersion: ctx.version,
      wrappedKey: ctx.serverWrappedKey,
    });
  }
}
