import { Injectable } from '@nestjs/common';

export type SpaceMemberLeftContext = {
  organizationId: string;
  spaceId: string;
  /** The person who stopped being a member of the space. */
  userId: string;
  now: Date;
};

export type SpaceMemberLeftHook = {
  name: string;
  onSpaceMemberLeft(ctx: SpaceMemberLeftContext): Promise<void>;
};

// Registro global de ganchos de saída do ESPAÇO: outros módulos (ex.: `hubs`) assinam aqui, sem o `spaces`
// conhecê-los. O `spaces` emite uma vez por espaço: ao tirar alguém, ao sair e no gancho de saída da organização
// (um por espaço de que a pessoa saiu). Rodam em sequência, dentro do unit of work da saída, DEPOIS das lápides
// (com o espaço travado); erro de um desfaz tudo (a saída não acontece).
@Injectable()
export class SpaceMemberLeftHooks {
  private readonly hooks: SpaceMemberLeftHook[] = [];

  register(hook: SpaceMemberLeftHook): void {
    if (this.hooks.some((h) => h.name === hook.name)) {
      throw new Error(
        `Space-member-left hook "${hook.name}" is already registered.`,
      );
    }
    this.hooks.push(hook);
  }

  unregister(name: string): void {
    const i = this.hooks.findIndex((h) => h.name === name);
    if (i >= 0) this.hooks.splice(i, 1);
  }

  async run(ctx: SpaceMemberLeftContext): Promise<void> {
    for (const hook of this.hooks) await hook.onSpaceMemberLeft(ctx);
  }
}
