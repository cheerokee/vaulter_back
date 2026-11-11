import { Injectable } from '@nestjs/common';

export type AiBudgetRaisedContext = {
  organizationId: string;
  fromMicroUsd: bigint;
  toMicroUsd: bigint;
};

export type AiBudgetRaisedHook = {
  name: string;
  onAiBudgetRaised(ctx: AiBudgetRaisedContext): Promise<void>;
};

// Registro global de quem reage ao AUMENTO do orçamento de IA de uma organização (spec active-cloud §4.4), sem o
// `organizations` conhecê-lo. O `cloud` assina: retoma a indexação que parou por falta de orçamento (Review Focus 3).
// Mesma regra dos outros ganchos: assina em `onModuleInit`, roda em sequência DENTRO do unit of work que grava o
// orçamento, com a linha da organização travada (`FOR NO KEY UPDATE`) e depois da gravação; erro de um desfaz o ajuste.
// Um gancho não trava nada antes da organização (ela é folha: só lê e enfileira tarefas na mesma transação).
@Injectable()
export class AiBudgetRaisedHooks {
  private readonly hooks: AiBudgetRaisedHook[] = [];

  register(hook: AiBudgetRaisedHook): void {
    if (this.hooks.some((h) => h.name === hook.name)) {
      throw new Error(
        `AI-budget-raised hook "${hook.name}" is already registered.`,
      );
    }
    this.hooks.push(hook);
  }

  unregister(name: string): void {
    const i = this.hooks.findIndex((h) => h.name === name);
    if (i >= 0) this.hooks.splice(i, 1);
  }

  async run(ctx: AiBudgetRaisedContext): Promise<void> {
    if (ctx.toMicroUsd <= ctx.fromMicroUsd) return;
    for (const hook of this.hooks) await hook.onAiBudgetRaised(ctx);
  }
}
