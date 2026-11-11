import { Injectable } from '@nestjs/common';

export type SpaceKeyRotatedContext = {
  organizationId: string;
  spaceId: string;
  /** The new `space_keys` row and its version. */
  spaceKeyId: string;
  version: number;
  /**
   * The new version sealed for the server key (`0x01 ‖ crypto_box_seal`, 108 base64url chars, format already
   * checked by `spaces`). Present exactly when the space is in `active_cloud` (the `spaces` module refuses the
   * rotation otherwise: 409 `key-rotation-mismatch` with `missingServer`/`unexpectedServer`).
   */
  serverWrappedKey: string | null;
  actorUserId: string;
};

export type SpaceKeyRotatedHook = {
  name: string;
  onSpaceKeyRotated(ctx: SpaceKeyRotatedContext): Promise<void>;
};

// Registro global de quem reage a uma versão nova da chave de um espaço, sem o `spaces` conhecê-lo. O `cloud` assina:
// guarda a cópia da versão nova para a chave do servidor (nuvem ativa), depois de conferir que ela abre. Mesma regra
// dos outros ganchos: assina em `onModuleInit`, roda em sequência DENTRO do unit of work da troca, com o espaço
// travado (`FOR UPDATE`) e depois das gravações do `spaces`; erro de um desfaz a troca inteira (nada gravado).
@Injectable()
export class SpaceKeyRotatedHooks {
  private readonly hooks: SpaceKeyRotatedHook[] = [];

  register(hook: SpaceKeyRotatedHook): void {
    if (this.hooks.some((h) => h.name === hook.name)) {
      throw new Error(
        `Space-key-rotated hook "${hook.name}" is already registered.`,
      );
    }
    this.hooks.push(hook);
  }

  unregister(name: string): void {
    const i = this.hooks.findIndex((h) => h.name === name);
    if (i >= 0) this.hooks.splice(i, 1);
  }

  /**
   * A server copy with nobody registered to keep it would be silently dropped (the space would then lack the
   * server copy of this version): a programming error, never a client one.
   */
  async run(ctx: SpaceKeyRotatedContext): Promise<void> {
    if (ctx.serverWrappedKey !== null && this.hooks.length === 0) {
      throw new Error(
        'A server key copy was sent but no space-key-rotated hook is registered.',
      );
    }
    for (const hook of this.hooks) await hook.onSpaceKeyRotated(ctx);
  }
}
