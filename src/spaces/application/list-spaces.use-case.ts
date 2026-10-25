import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { OrganizationAccess } from '../../organizations/application/organization-access.js';
import type {
  CursorPage,
  CursorPageRequest,
} from '../../shared/domain/pagination.js';
import { SpaceRepository } from '../domain/space.repository.js';
import type { SpaceListItemView, SpaceSummaryView } from './dto/space-view.js';
import { RecoveryKit } from './recovery-kit.js';

export type ListSpacesInput = { all: boolean; page: CursorPageRequest };

// Sem `all`: os espaços da organização em que eu estou (membro da org), com meu papel e as flags; a contagem de
// pendências de trancar só aparece para Gestor. Com `all` (org.spaces.create): todos os espaços, só com id,
// nome, número de membros (0 = órfão), "retrancar pendente" e data — nada de chave nem de papel. O app confere
// essa lista antes de trocar o kit da organização (veja CLAUDE.md, módulo spaces).
@Injectable()
export class ListSpacesUseCase {
  constructor(
    private readonly orgAccess: OrganizationAccess,
    private readonly kit: RecoveryKit,
    private readonly spaces: SpaceRepository,
  ) {}

  execute(
    actor: Actor,
    orgId: string,
    input: { all: true; page: CursorPageRequest },
  ): Promise<CursorPage<SpaceSummaryView>>;
  execute(
    actor: Actor,
    orgId: string,
    input: { all: false; page: CursorPageRequest },
  ): Promise<CursorPage<SpaceListItemView>>;
  execute(
    actor: Actor,
    orgId: string,
    input: ListSpacesInput,
  ): Promise<CursorPage<SpaceListItemView> | CursorPage<SpaceSummaryView>>;
  async execute(
    actor: Actor,
    orgId: string,
    input: ListSpacesInput,
  ): Promise<CursorPage<SpaceListItemView> | CursorPage<SpaceSummaryView>> {
    return input.all
      ? this.listAll(actor, orgId, input.page)
      : this.listMine(actor, orgId, input.page);
  }

  private async listAll(
    actor: Actor,
    orgId: string,
    page: CursorPageRequest,
  ): Promise<CursorPage<SpaceSummaryView>> {
    await this.orgAccess.requirePermission(
      orgId,
      actor.userId,
      'org.spaces.create',
    );
    const fingerprint = await this.kit.currentFingerprint(orgId);
    const result = await this.spaces.listAll(orgId, fingerprint, page);
    return {
      items: result.items.map((item) => ({
        id: item.space.id,
        name: item.space.name,
        memberCount: item.memberCount,
        recoveryRewrapRequired: item.recoveryRewrapRequired,
        createdAt: item.space.createdAt ?? null,
      })),
      nextCursor: result.nextCursor,
    };
  }

  private async listMine(
    actor: Actor,
    orgId: string,
    page: CursorPageRequest,
  ): Promise<CursorPage<SpaceListItemView>> {
    await this.orgAccess.requireMember(orgId, actor.userId);
    const fingerprint = await this.kit.currentFingerprint(orgId);
    const result = await this.spaces.listForMember(
      orgId,
      actor.userId,
      fingerprint,
      page,
    );
    return {
      items: result.items.map((item) => ({
        id: item.space.id,
        organizationId: item.space.organizationId,
        name: item.space.name,
        roleKey: item.roleKey,
        currentKeyVersion: item.space.currentKeyVersion,
        keyRotationRequired: item.keyRotationRequired,
        recoveryRewrapRequired: item.recoveryRewrapRequired,
        createdAt: item.space.createdAt ?? null,
        ...(item.roleKey === 'space_manager'
          ? { pendingGrants: item.pendingGrants }
          : {}),
      })),
      nextCursor: result.nextCursor,
    };
  }
}
