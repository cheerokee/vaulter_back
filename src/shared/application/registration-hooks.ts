import { Injectable } from '@nestjs/common';

export type RegistrationHookContext = {
  userId: string;
  name: string;
  email: string;
  inviteToken?: string;
  now: Date;
};

export type RegistrationHookResult = {
  invitation?: { accepted: boolean };
};

export type RegistrationHook = {
  name: string;
  onRegistered(
    ctx: RegistrationHookContext,
  ): Promise<RegistrationHookResult | void>;
};

// Registro global de ganchos de cadastro: outros módulos assinam aqui, sem o `identity` conhecê-los.
// Os ganchos rodam em sequência, dentro da transação do cadastro; erro de um desfaz tudo.
@Injectable()
export class RegistrationHooks {
  private readonly hooks: RegistrationHook[] = [];

  register(hook: RegistrationHook): void {
    if (this.hooks.some((h) => h.name === hook.name)) {
      throw new Error(
        `Registration hook "${hook.name}" is already registered.`,
      );
    }
    this.hooks.push(hook);
  }

  unregister(name: string): void {
    const i = this.hooks.findIndex((h) => h.name === name);
    if (i >= 0) this.hooks.splice(i, 1);
  }

  async run(ctx: RegistrationHookContext): Promise<RegistrationHookResult> {
    const merged: RegistrationHookResult = {};
    for (const hook of this.hooks) {
      const result = await hook.onRegistered(ctx);
      if (!result) continue;
      for (const key of Object.keys(
        result,
      ) as (keyof RegistrationHookResult)[]) {
        if (result[key] === undefined) continue;
        if (merged[key] !== undefined) {
          // Erro de programação: dois ganchos disputando o mesmo campo.
          throw new Error(
            `Registration hook "${hook.name}" returned "${key}", already set by an earlier hook.`,
          );
        }
        Object.assign(merged, { [key]: result[key] });
      }
    }
    return merged;
  }
}
