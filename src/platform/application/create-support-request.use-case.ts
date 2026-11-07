import { Injectable } from '@nestjs/common';
import { HubAdministration } from '../../hubs/application/hub-administration.js';
import { CurrentAuthProofVerifier } from '../../identity/application/current-auth-proof-verifier.js';
import type { Actor } from '../../identity/application/dto/actor.js';
import { UserDirectory } from '../../identity/application/user-directory.js';
import { OrganizationAdministration } from '../../organizations/application/organization-administration.js';
import { NotFoundError } from '../../shared/domain/errors.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { PlatformRoleRepository } from '../domain/platform-role.repository.js';
import {
  SupportRequest,
  type PlatformSupportRequestType,
} from '../domain/support-request.js';
import { SupportRequestRepository } from '../domain/support-request.repository.js';
import { requireExistingUser } from './grant-platform-role.use-case.js';
import { PlatformAccess } from './platform-access.js';
import { PlatformAudit } from './platform-audit.js';
import { supportRequestAuditEntry } from './support-request-audit.js';
import {
  staffCannotBeAppointed,
  SupportRequestExecutor,
} from './support-request-executor.js';

export type CreateSupportRequestInput = {
  type: PlatformSupportRequestType;
  hubId?: string;
  organizationId?: string;
  userId?: string;
  reason: string;
  evidence: string;
  currentAuthProof: string;
};

// Abre um pedido de suporte (spec §4.3). Ordem:
// 1. permissão (404 sem `platform.support.request`), formato do pedido (tipo × alvo, textos) e alvos: Hub /
//    organização / conta existem (404; um Hub já desregistrado passa e o pedido falha na execução) e o nomeado não
//    é da equipe (422 `staff-cannot-be-appointed`), sem gastar o Argon2;
// 2. reautenticação FORA da transação;
// 3. na transação: trava os admins FOR SHARE (`lockAdminsForShare`: uma concessão/retirada de papel concorrente,
//    que começa com `lockAdmins` FOR UPDATE, espera ou é esperada), reconfere as permissões e o alvo, grava e audita. Com `platform.support.execute_alone` o pedido
//    nasce aprovado por quem pediu e é executado na mesma transação; sem, fica pendente para outra pessoa.
@Injectable()
export class CreateSupportRequestUseCase {
  constructor(
    private readonly access: PlatformAccess,
    private readonly roles: PlatformRoleRepository,
    private readonly repo: SupportRequestRepository,
    private readonly audit: PlatformAudit,
    private readonly executor: SupportRequestExecutor,
    private readonly verifier: CurrentAuthProofVerifier,
    private readonly directory: UserDirectory,
    private readonly hubs: HubAdministration,
    private readonly orgs: OrganizationAdministration,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(
    actor: Actor,
    input: CreateSupportRequestInput,
  ): Promise<SupportRequest> {
    await this.access.require(actor.userId, 'platform.support.request');
    // Validates type × target and the texts; the creation time is set again in the transaction.
    const draft = this.build(actor, input, new Date(), false);
    await this.requireTarget(draft);
    await this.verifier.verify(actor.userId, input.currentAuthProof);

    return this.uow.run(async () => {
      await this.roles.lockAdminsForShare();
      const permissions = await this.access.require(
        actor.userId,
        'platform.support.request',
      );
      await this.requireNotStaff(draft);
      const executeAlone = permissions.includes(
        'platform.support.execute_alone',
      );
      const now = new Date();
      const request = this.build(actor, input, now, executeAlone);
      await this.repo.insert(request);
      await this.audit.record(
        supportRequestAuditEntry(
          request,
          'platform.request.created',
          actor.userId,
        ),
      );
      if (executeAlone) {
        await this.audit.record(
          supportRequestAuditEntry(
            request,
            'platform.request.approved',
            actor.userId,
            { executeAlone: true },
          ),
        );
        await this.executor.execute(request, now);
      }
      return request;
    });
  }

  private build(
    actor: Actor,
    input: CreateSupportRequestInput,
    now: Date,
    approvedOnCreation: boolean,
  ): SupportRequest {
    return SupportRequest.create({
      type: input.type,
      target: {
        hubId: input.hubId,
        organizationId: input.organizationId,
        userId: input.userId,
      },
      reason: input.reason,
      evidence: input.evidence,
      requestedBy: actor.userId,
      now,
      approvedOnCreation,
    });
  }

  private async requireTarget(draft: SupportRequest): Promise<void> {
    if (draft.type === 'hub_force_deregister') {
      if (!(await this.hubs.summary(draft.targetHubId!))) {
        throw new NotFoundError('hub-not-found', 'The hub was not found.');
      }
      return;
    }
    if (!(await this.orgs.summary(draft.targetOrganizationId!))) {
      throw new NotFoundError(
        'organization-not-found',
        'The organization was not found.',
      );
    }
    await requireExistingUser(this.directory, draft.targetUserId!);
    await this.requireNotStaff(draft);
  }

  private async requireNotStaff(draft: SupportRequest): Promise<void> {
    if (
      draft.type === 'org_appoint_admin' &&
      (await this.roles.hasAnyRole(draft.targetUserId!))
    ) {
      throw staffCannotBeAppointed();
    }
  }
}
