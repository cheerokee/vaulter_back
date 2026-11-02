import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import { ConflictError } from '../../shared/domain/errors.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { CLAIM_CODE_PATTERN, claimCodeInvalid } from '../domain/enrollment.js';
import { EnrollmentRepository } from '../domain/enrollment.repository.js';
import { HubOrganizationLink } from '../domain/hub-organization-link.js';
import { HubOrganizationRepository } from '../domain/hub-organization.repository.js';
import { HubRoleRepository } from '../domain/hub-role.repository.js';
import { assertHubName, Hub } from '../domain/hub.js';
import { HubRepository } from '../domain/hub.repository.js';
import { toHubView, type HubView } from './dto/hub-view.js';
import { HubCodeHasher } from './ports/hub-code-hasher.js';

export type ClaimHubInput = { claimCode: string; name: string };

// O dono reivindica o Hub pelo código de 8 dígitos. Código errado, desconhecido, vencido ou já usado: o MESMO
// 422 `claim-code-invalid`. O nome é conferido ANTES do código (senão o erro de nome diria que o código vale).
// Tudo numa transação: trava a apresentação pendente (FOR UPDATE: uma reivindicação concorrente do mesmo código
// espera e, depois do COMMIT da vencedora, não acha mais a linha), cria o Hub, consome a apresentação, dá
// hub_owner ao dono e hub_room à Sala, vincula a organização pessoal do dono SEMPRE aprovada (spec §4.3: o dono é
// org_admin da pessoal, então os dois consentimentos são dele, qualquer que seja a política) e audita `hub.claimed`
// na organização pessoal.
// Ordem de locks: apresentação -> Hub (novo; o upsert do vínculo o trava FOR SHARE) -> vínculo.
@Injectable()
export class ClaimHubUseCase {
  constructor(
    private readonly enrollments: EnrollmentRepository,
    private readonly hubs: HubRepository,
    private readonly hubRoles: HubRoleRepository,
    private readonly links: HubOrganizationRepository,
    private readonly codes: HubCodeHasher,
    private readonly orgDirectory: OrganizationDirectory,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(actor: Actor, input: ClaimHubInput): Promise<HubView> {
    const name = assertHubName(input.name);
    if (
      typeof input.claimCode !== 'string' ||
      !CLAIM_CODE_PATTERN.test(input.claimCode)
    ) {
      throw claimCodeInvalid();
    }
    const codeHash = await this.codes.hash(input.claimCode);
    const now = new Date();

    return this.uow.run(async () => {
      await this.uow.setContext({ userId: actor.userId });
      const enrollment = await this.enrollments.lockPendingByCodeHash(codeHash);
      if (!enrollment) throw claimCodeInvalid();
      const hub = Hub.claim({
        enrollment,
        ownerUserId: actor.userId,
        name,
        now,
      });

      const personalOrgId = await this.orgDirectory.personalOrganizationIdOf(
        actor.userId,
      );
      const policy = personalOrgId
        ? await this.orgDirectory.hubLinkPolicy(personalOrgId)
        : null;
      if (!personalOrgId || !policy) {
        // Todo usuário ganha a organização pessoal no cadastro: faltar é defeito de dados, não erro de quem chama.
        throw new Error(
          `User ${actor.userId} has no personal organization to link the hub to.`,
        );
      }

      try {
        await this.hubs.create(hub);
      } catch (error) {
        // Duas apresentações da mesma chave reivindicadas ao mesmo tempo: a perdedora vê só o erro único.
        if (
          error instanceof ConflictError &&
          error.code === 'signing-key-in-use'
        ) {
          throw claimCodeInvalid();
        }
        throw error;
      }
      if (!(await this.enrollments.markClaimed(enrollment.id, hub.id, now))) {
        throw claimCodeInvalid();
      }
      enrollment.markClaimed(hub.id);
      await this.hubRoles.grantSystemRoles(hub.id, actor.userId);

      await this.links.upsert(
        HubOrganizationLink.ownerLinksAsOrgAdmin({
          hubId: hub.id,
          organizationId: personalOrgId,
          userId: actor.userId,
          policy,
          now,
          existing: null,
        }),
      );
      await this.audit.record({
        organizationId: personalOrgId,
        userId: actor.userId,
        action: 'hub.claimed',
        metadata: { hubId: hub.id },
      });
      return toHubView(hub);
    });
  }
}
