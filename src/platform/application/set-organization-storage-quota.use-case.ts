import { Injectable } from '@nestjs/common';
import { CurrentAuthProofVerifier } from '../../identity/application/current-auth-proof-verifier.js';
import type { Actor } from '../../identity/application/dto/actor.js';
import { OrganizationAdministration } from '../../organizations/application/organization-administration.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { PlatformAccess } from './platform-access.js';
import { PlatformAudit } from './platform-audit.js';

export type SetStorageQuotaInput = {
  quotaBytes: number;
  reason: string;
  currentAuthProof: string;
};

// O financeiro ajusta a franquia de nuvem de uma organização (spec storage-backup §4.4). Ordem:
// 1. permissão (404 sem `platform.billing.storage_quota`), sem gastar o Argon2;
// 2. reautenticação FORA da transação;
// 3. numa transação: a organização trava a linha, confere o reservado e grava (404 se não existe, 422 abaixo do
//    reservado); a trilha da plataforma entra na mesma transação. Sem pedido de suporte: a ação é da permissão.
@Injectable()
export class SetOrganizationStorageQuotaUseCase {
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
    input: SetStorageQuotaInput,
  ): Promise<{ organizationId: string; fromBytes: number; toBytes: number }> {
    await this.access.require(actor.userId, 'platform.billing.storage_quota');
    await this.verifier.verify(actor.userId, input.currentAuthProof);
    return this.uow.run(async () => {
      const { fromBytes, toBytes } = await this.organizations.setStorageQuota(
        organizationId,
        input.quotaBytes,
        { kind: 'platform_staff', staffAction: 'storage_quota_changed' },
      );
      await this.audit.record({
        userId: actor.userId,
        action: 'platform.organization.storage_quota_changed',
        result: 'success',
        targetOrganizationId: organizationId,
        metadata: { from: fromBytes, to: toBytes, reason: input.reason },
      });
      return { organizationId, fromBytes, toBytes };
    });
  }
}
