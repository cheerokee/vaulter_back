import { Injectable } from '@nestjs/common';
import { CurrentAuthProofVerifier } from '../../identity/application/current-auth-proof-verifier.js';
import type { Actor } from '../../identity/application/dto/actor.js';
import { OrganizationAdministration } from '../../organizations/application/organization-administration.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { PlatformAccess } from './platform-access.js';
import { PlatformAudit } from './platform-audit.js';

export type SetAiBudgetInput = {
  budgetMicroUsd: number;
  reason: string;
  currentAuthProof: string;
};

// O financeiro ajusta o orçamento mensal de IA de uma organização (spec active-cloud §4.4), no mesmo modelo da
// franquia de armazenamento. Ordem:
// 1. permissão (404 sem `platform.billing.ai_budget`), sem gastar o Argon2;
// 2. reautenticação FORA da transação;
// 3. numa transação: a organização trava a linha e grava (404 se não existe); num aumento, os ganchos do orçamento
//    (o `cloud` retoma a indexação parada) rodam na mesma transação; a trilha da plataforma também.
@Injectable()
export class SetOrganizationAiBudgetUseCase {
  constructor(
    private readonly access: PlatformAccess,
    private readonly verifier: CurrentAuthProofVerifier,
    private readonly organizations: OrganizationAdministration,
    private readonly audit: PlatformAudit,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(
    actor: Actor,
    organizationId: string,
    input: SetAiBudgetInput,
  ): Promise<{
    organizationId: string;
    fromMicroUsd: number;
    toMicroUsd: number;
  }> {
    await this.access.require(actor.userId, 'platform.billing.ai_budget');
    await this.verifier.verify(actor.userId, input.currentAuthProof);
    return this.uow.run(async () => {
      const change = await this.organizations.setAiBudget(
        organizationId,
        BigInt(input.budgetMicroUsd),
        { kind: 'platform_staff', staffAction: 'ai_budget_changed' },
      );
      const fromMicroUsd = Number(change.fromMicroUsd);
      const toMicroUsd = Number(change.toMicroUsd);
      await this.audit.record({
        userId: actor.userId,
        action: 'platform.organization.ai_budget_changed',
        result: 'success',
        targetOrganizationId: organizationId,
        metadata: { from: fromMicroUsd, to: toMicroUsd, reason: input.reason },
      });
      return { organizationId, fromMicroUsd, toMicroUsd };
    });
  }
}
