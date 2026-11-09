import { Injectable } from '@nestjs/common';

export type SpaceQuotaContext = { organizationId: string; spaceId: string };

export type SpaceQuotaIncrease = SpaceQuotaContext & {
  /** Who resizes: a hook may hide figures the caller must not see (e.g. bytes reserved by other organizations). */
  actorUserId: string;
  fromBytes: number;
  toBytes: number;
};

export type SpaceQuotaHook = {
  name: string;
  /**
   * Before the space row is locked: lock what comes BEFORE the space in the lock order (the `hubs` module: the
   * Hubs where the space is installed). Runs on every resize.
   */
  lock(ctx: SpaceQuotaContext): Promise<void>;
  /** With the space locked and the organization quota checked: refuse a growth by throwing a domain error. */
  assertIncrease(ctx: SpaceQuotaIncrease): Promise<void>;
};

// Registro global de quem tem a dizer sobre o tamanho de um espaço, sem o `spaces` conhecê-lo (o `hubs` assina: a
// capacidade de cada Hub onde o espaço está instalado). Mesma regra dos outros ganchos: assina em `onModuleInit`,
// roda em sequência dentro do unit of work da mudança de tamanho; erro desfaz tudo.
@Injectable()
export class SpaceQuotaHooks {
  private readonly hooks: SpaceQuotaHook[] = [];

  register(hook: SpaceQuotaHook): void {
    if (this.hooks.some((h) => h.name === hook.name)) {
      throw new Error(`Space-quota hook "${hook.name}" is already registered.`);
    }
    this.hooks.push(hook);
  }

  unregister(name: string): void {
    const i = this.hooks.findIndex((h) => h.name === name);
    if (i >= 0) this.hooks.splice(i, 1);
  }

  async lock(ctx: SpaceQuotaContext): Promise<void> {
    for (const hook of this.hooks) await hook.lock(ctx);
  }

  async assertIncrease(ctx: SpaceQuotaIncrease): Promise<void> {
    for (const hook of this.hooks) await hook.assertIncrease(ctx);
  }
}
