import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { CurrentAuthProofVerifier } from '../../identity/application/current-auth-proof-verifier.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { OrganizationRepository } from '../domain/organization.repository.js';
import { assertRecoveryPublicKey } from '../domain/recovery-key.js';
import { AuditLog } from './audit-log.js';
import {
  toOrganizationView,
  type OrganizationView,
} from './dto/organization-view.js';
import { loadOrganization } from './load-organization.js';
import { OrganizationAccess } from './organization-access.js';

export type SetRecoveryKeyInput = {
  recoveryPublicKey: string;
  currentAuthProof: string;
};

// Registra ou substitui a chave pública do kit de recuperação. Ordem:
// 1. formato da chave (barato, 422 sem gastar o Argon2);
// 2. permissão (não membro 404, membro comum 403), também sem gastar o Argon2;
// 3. reautenticação (`current-auth-proof-invalid`), FORA da transação, para não segurar conexão no Argon2;
// 4. na transação: permissão de novo (pode ter mudado no meio), grava e audita.
// A auditoria não leva metadata: a chave é pública, mas não é preciso copiá-la; a prova nunca entra.
@Injectable()
export class SetRecoveryKeyUseCase {
  constructor(
    private readonly verifier: CurrentAuthProofVerifier,
    private readonly access: OrganizationAccess,
    private readonly orgs: OrganizationRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(
    actor: Actor,
    orgId: string,
    input: SetRecoveryKeyInput,
  ): Promise<OrganizationView> {
    assertRecoveryPublicKey(input.recoveryPublicKey);
    await this.access.requirePermission(
      orgId,
      actor.userId,
      'org.members.manage',
    );
    await this.verifier.verify(actor.userId, input.currentAuthProof);
    return this.uow.run(async () => {
      const membership = await this.access.requirePermission(
        orgId,
        actor.userId,
        'org.members.manage',
      );
      const org = await loadOrganization(this.orgs, orgId);
      const outcome = org.setRecoveryKey(input.recoveryPublicKey);
      await this.orgs.save(org);
      await this.audit.record({
        organizationId: orgId,
        userId: actor.userId,
        action: `organization.recovery_key.${outcome}`,
      });
      return toOrganizationView(org, membership.roleKey);
    });
  }
}
