import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { OrganizationAccess } from '../../organizations/application/organization-access.js';
import { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { HubOrganizationLink } from '../domain/hub-organization-link.js';
import { HubOrganizationRepository } from '../domain/hub-organization.repository.js';
import { HubRepository } from '../domain/hub.repository.js';
import { LINK_CODE_PATTERN, linkCodeInvalid } from '../domain/link-code.js';
import { LinkCodeRepository } from '../domain/link-code.repository.js';
import type { HubLinkRequestView } from './dto/hub-link-view.js';
import { currentLinkPolicy } from './link-policy.js';
import { HubCodeHasher } from './ports/hub-code-hasher.js';

// Outro usuário pede o vínculo da organização dele (`POST /hubs/link-requests`, spec §4.6) com o código de vínculo
// que o Hub mostra: prova que está diante do aparelho, sem conhecer o `hubId` (a resposta também não o traz).
// Ordem: formato do código (sem tocar o banco) -> membro da organização (404, ANTES de consumir: quem não é
// membro não gasta o código de ninguém) -> consome o código (uso único, condicional) -> Hub ativo (FOR SHARE) ->
// vínculo (FOR UPDATE) -> pedido. Código errado, vencido, usado ou de Hub desregistrado: o MESMO 422
// `link-code-invalid`. Erro depois do consumo (ex.: `already-linked`) desfaz a transação, e o código continua
// valendo até vencer. Se quem pede é o próprio dono, vale como o vínculo do dono.
@Injectable()
export class RequestHubLinkUseCase {
  constructor(
    private readonly orgAccess: OrganizationAccess,
    private readonly directory: OrganizationDirectory,
    private readonly codes: HubCodeHasher,
    private readonly linkCodes: LinkCodeRepository,
    private readonly hubs: HubRepository,
    private readonly links: HubOrganizationRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(
    actor: Actor,
    input: { linkCode: string; organizationId: string },
  ): Promise<HubLinkRequestView> {
    if (
      typeof input.linkCode !== 'string' ||
      !LINK_CODE_PATTERN.test(input.linkCode)
    ) {
      throw linkCodeInvalid();
    }
    const { organizationId } = input;
    const codeHash = await this.codes.hashLinkCode(input.linkCode);
    const now = new Date();
    return this.uow.run(async () => {
      await this.uow.setContext({ userId: actor.userId });
      await this.orgAccess.requireMember(organizationId, actor.userId);
      const code = await this.linkCodes.consume(codeHash, now);
      if (!code) throw linkCodeInvalid();
      const hub = await this.hubs.lockForShare(code.hubId);
      if (!hub) throw linkCodeInvalid();
      const policy = await currentLinkPolicy(this.directory, organizationId);
      const existing = await this.links.lockForUpdate(hub.id, organizationId);
      const start = {
        hubId: hub.id,
        organizationId,
        userId: actor.userId,
        policy,
        now,
        existing,
      };
      const byOwner = hub.ownerUserId === actor.userId;
      const link = byOwner
        ? HubOrganizationLink.ownerLinks(start)
        : HubOrganizationLink.requestByOther(start);
      await this.links.upsert(link);
      await this.audit.record({
        organizationId,
        userId: actor.userId,
        action: 'hub.organization.requested',
        metadata: {
          hubId: hub.id,
          by: byOwner ? 'owner' : 'member',
          via: 'link_code',
          status: link.status,
        },
      });
      return { organizationId, status: link.status };
    });
  }
}
