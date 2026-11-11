import { Injectable } from '@nestjs/common';

/** Where the month's AI spend of an organization comes from (the `cloud` module's usage ledger). */
export type OrganizationAiSpendSource = {
  /** Spent + live reservations of the current month (UTC, database clock), in micro-USD. */
  consumedMicroUsd(organizationId: string): Promise<bigint>;
};

// Porta exportada (como `SpaceStorageUsage` do `spaces`): o `organizations` mostra o estado do orçamento de IA no
// `GET /organizations/:id` sem conhecer o livro de uso, que mora no `cloud`. O `cloud` registra a fonte em
// `onModuleInit` (`register`, `unregister` no destroy). Sem fonte (o módulo `cloud` fora da aplicação): 0.
@Injectable()
export class OrganizationAiSpend {
  private source: OrganizationAiSpendSource | null = null;

  register(source: OrganizationAiSpendSource): void {
    if (this.source) {
      throw new Error('An organization AI spend source is already registered.');
    }
    this.source = source;
  }

  unregister(): void {
    this.source = null;
  }

  async consumedMicroUsd(organizationId: string): Promise<bigint> {
    return this.source ? this.source.consumedMicroUsd(organizationId) : 0n;
  }
}
