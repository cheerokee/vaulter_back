import { Injectable } from '@nestjs/common';

/** Why a hub stopped being a valid executor in an organization (spec conversations §4.1). */
export type HubExecutorLostReason =
  'hub_deregistered' | 'organization_unlinked' | 'space_removed_from_hub';

export type HubExecutorLostContext = {
  hubId: string;
  organizationId: string;
  /** The space taken off the hub; null = every space of the organization on that hub. */
  spaceId: string | null;
  reason: HubExecutorLostReason;
  /** Who caused it (audit); null for a system cascade. */
  actorId: string | null;
  now: Date;
};

export type HubExecutorLostHook = {
  name: string;
  /** Lower runs first (default 0; ties keep the registration order). */
  order?: number;
  onExecutorLost(ctx: HubExecutorLostContext): Promise<void>;
};

// Registro global de ganchos "o Hub deixou de valer numa organização/espaço": o `hubs` emite, sem conhecer quem
// assina (ex.: `conversations`, que tira o executor dos assuntos). Emitido no desregistro (uma vez por organização a
// que o Hub já foi vinculado), no desvínculo (`HubLinkCascade`, inclusive pelo gancho de saída da organização) e ao
// tirar um espaço do Hub (`RemoveHubSpace`): onde quer que um `hub_space` morra. Roda em sequência, dentro do unit of
// work de quem emite, DEPOIS das lápides do `hubs` e da Sala (ordem de locks: Hub -> vínculo -> hub_space -> espaço
// -> o que o gancho travar); erro de um desfaz a operação inteira.
@Injectable()
export class HubExecutorLostHooks {
  private readonly hooks: HubExecutorLostHook[] = [];

  register(hook: HubExecutorLostHook): void {
    if (this.hooks.some((h) => h.name === hook.name)) {
      throw new Error(
        `Hub-executor-lost hook "${hook.name}" is already registered.`,
      );
    }
    this.hooks.push(hook);
    // sort é estável: empate mantém a ordem de registro.
    this.hooks.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  unregister(name: string): void {
    const i = this.hooks.findIndex((h) => h.name === name);
    if (i >= 0) this.hooks.splice(i, 1);
  }

  async run(ctx: HubExecutorLostContext): Promise<void> {
    for (const hook of this.hooks) await hook.onExecutorLost(ctx);
  }
}
