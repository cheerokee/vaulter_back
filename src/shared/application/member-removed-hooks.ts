import { Injectable } from '@nestjs/common';

export type MemberRemovedContext = {
  organizationId: string;
  /** The person who stopped being a member. */
  userId: string;
  /** Who did it: another admin (`removed`) or the person themselves (`left`). */
  actorId: string;
  reason: 'removed' | 'left';
  now: Date;
};

export type MemberRemovedHook = {
  name: string;
  onMemberRemoved(ctx: MemberRemovedContext): Promise<void>;
};

// Registro global de ganchos de saída da organização: outros módulos (ex.: `spaces`) assinam aqui, sem o
// `organizations` conhecê-los. Rodam em sequência, dentro do unit of work da remoção/saída, DEPOIS da lápide
// do vínculo; erro de um desfaz tudo (a remoção não acontece).
@Injectable()
export class MemberRemovedHooks {
  private readonly hooks: MemberRemovedHook[] = [];

  register(hook: MemberRemovedHook): void {
    if (this.hooks.some((h) => h.name === hook.name)) {
      throw new Error(
        `Member-removed hook "${hook.name}" is already registered.`,
      );
    }
    this.hooks.push(hook);
  }

  unregister(name: string): void {
    const i = this.hooks.findIndex((h) => h.name === name);
    if (i >= 0) this.hooks.splice(i, 1);
  }

  async run(ctx: MemberRemovedContext): Promise<void> {
    for (const hook of this.hooks) await hook.onMemberRemoved(ctx);
  }
}
