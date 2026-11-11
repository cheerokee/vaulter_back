import { Injectable } from '@nestjs/common';

export type SpaceCloudDeactivatedContext = {
  organizationId: string;
  spaceId: string;
  /** Who switched it off (audit). */
  actorUserId: string;
  now: Date;
};

export type SpaceCloudDeactivatedHook = {
  name: string;
  onSpaceCloudDeactivated(ctx: SpaceCloudDeactivatedContext): Promise<void>;
};

// Registro global de quem reage a um espaço sair da nuvem ativa, sem o `cloud` conhecê-lo. O `conversations` assina:
// a nuvem deixa de ser executor de reserva em todo assunto do espaço (cópias da chave do assunto para o servidor
// APAGADAS, troca de chave pendente). Mesma regra dos outros ganchos: assina em `onModuleInit`, roda em sequência
// DENTRO do unit of work do desligar, com o espaço travado `FOR UPDATE` (o que o gancho travar vem depois); erro de um
// desfaz o desligar inteiro.
@Injectable()
export class SpaceCloudDeactivatedHooks {
  private readonly hooks: SpaceCloudDeactivatedHook[] = [];

  register(hook: SpaceCloudDeactivatedHook): void {
    if (this.hooks.some((h) => h.name === hook.name)) {
      throw new Error(
        `Space-cloud-deactivated hook "${hook.name}" is already registered.`,
      );
    }
    this.hooks.push(hook);
  }

  unregister(name: string): void {
    const i = this.hooks.findIndex((h) => h.name === name);
    if (i >= 0) this.hooks.splice(i, 1);
  }

  async run(ctx: SpaceCloudDeactivatedContext): Promise<void> {
    for (const hook of this.hooks) await hook.onSpaceCloudDeactivated(ctx);
  }
}
