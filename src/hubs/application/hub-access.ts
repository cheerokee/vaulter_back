import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { HubRoleRepository } from '../domain/hub-role.repository.js';
import type { AssignableHubRole } from '../domain/hub-roles.js';
import type { Hub } from '../domain/hub.js';
import { HubRepository } from '../domain/hub.repository.js';
import { hubNotFound, hubPermissionDenied } from './hub-errors.js';

/** The caller's role on a hub (spec §6). `hub_room` is the Room, never a person. */
export type HubRole = 'hub_owner' | AssignableHubRole;
export type HubAccessGrant = { hub: Hub; role: HubRole };

// Checagem de acesso ao Hub, exportada (o equivalente do `OrganizationAccess`/`SpaceAccess`; base das Tasks 8 e 9).
// Quem vê o Hub (spec §6): o dono (`hub_owner`), quem tem `hub_operator`/`hub_user` explícito e, sem linha, todo
// membro ativo de uma organização com vínculo aprovado (`hub_user` implícito). Quem tem papel explícito é sempre
// membro de uma organização vinculada: a atribuição exige isso e as cascatas (desvincular, saída da organização)
// tiram o papel de quem fica sem nenhuma. Por isso a visibilidade é a do RLS de `hubs` com `app.user_id` (dono, ou
// vínculo aprovado com organização de que a pessoa é membro ativo), lida só neste trecho (`withContext`).
// Quem não vê, Hub desregistrado, inexistente ou id malformado: o MESMO 404 `hub-not-found` (nunca revela que o Hub
// existe). Ação de dono num Hub que a pessoa vê: 403.
// Sem lock: as mutações travam o Hub (FOR SHARE/UPDATE) depois desta checagem, cada uma na ordem
// Hub -> vínculo -> hub_space -> espaço.
@Injectable()
export class HubAccess {
  constructor(
    private readonly hubs: HubRepository,
    private readonly roles: HubRoleRepository,
    private readonly uow: UnitOfWork,
  ) {}

  /** The caller's access, or null when they cannot see the hub (never throws for that). */
  async find(hubId: string, userId: string): Promise<HubAccessGrant | null> {
    if (!validate(hubId) || !validate(userId)) return null;
    return this.uow.withContext({ userId }, async () => {
      const hub = await this.hubs.findById(hubId);
      if (!hub || hub.isDeregistered) return null;
      if (hub.ownerUserId === userId) return { hub, role: 'hub_owner' };
      const explicit = await this.roles.roleOf(hubId, userId);
      return { hub, role: explicit ?? 'hub_user' };
    });
  }

  /** Anyone who sees the hub; 404 `hub-not-found` otherwise. */
  async requireAccess(hubId: string, userId: string): Promise<HubAccessGrant> {
    const grant = await this.find(hubId, userId);
    if (!grant) throw hubNotFound();
    return grant;
  }

  /** The owner only: 404 for whoever cannot see the hub, 403 for someone who sees it. */
  async requireOwner(hubId: string, userId: string): Promise<Hub> {
    const grant = await this.requireAccess(hubId, userId);
    if (grant.role !== 'hub_owner') throw hubPermissionDenied();
    return grant.hub;
  }
}
