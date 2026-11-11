import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import {
  NotFoundError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';
import { SpaceAccess } from '../../spaces/application/space-access.js';
import type { Space } from '../../spaces/domain/space.js';

/**
 * Who DECIDES the active cloud for an organization (accepts the term, authorizes a space, may switch it off):
 * `org.members.manage`, the permission that governs the recovery kit, the other way to read every space of the
 * organization (spec active-cloud §4.1: "um admin"). In a personal organization the person is its admin. The space
 * manager (`space.members.manage`, the Gestor, who has the key) sends the server copy and may switch it off too.
 */
export const CLOUD_DECIDER_PERMISSION = 'org.members.manage' as const;

/**
 * A session opened through a Hub (`POST /hub/user-sessions`, `actor.hubId` set: a kiosk on someone's shelf) never
 * decides about the cloud: accepting the term, authorizing, activating and switching off a space's cloud are refused
 * with the SAME 404 an outsider gets (`organization-not-found` / `space-not-found`), as the conversations do with what
 * a Hub session cannot reach. Checked first, before any read. Reading the state stays allowed.
 */
export function refuseHubSession(actor: Actor, notFound: () => Error): void {
  if (actor.hubId) throw notFound();
}

export const spaceNotFound = (): Error =>
  new NotFoundError('space-not-found', 'The space was not found.');

export const organizationNotFound = (): Error =>
  new NotFoundError(
    'organization-not-found',
    'The organization was not found.',
  );

// Acesso do módulo `cloud` a um espaço, por cima do `SpaceAccess` (exportado pelo `spaces`). As mutações rodam dentro
// do UnitOfWork.run e saem com a linha do espaço `FOR UPDATE` (o primeiro lock de toda operação da nuvem num espaço,
// também a troca de chave): ligar, desligar e trocar a chave se serializam.
@Injectable()
export class CloudSpaceAccess {
  constructor(private readonly access: SpaceAccess) {}

  /** Whoever decides (admin; need not be in the space). 404 outside, 403 for a member of the space without it. */
  lockAsDecider(spaceId: string, userId: string): Promise<Space> {
    return this.access.lockWithOrgPermission(
      spaceId,
      userId,
      CLOUD_DECIDER_PERMISSION,
    );
  }

  /** The space manager (member with the key). An admin outside the space: 404, like every space mutation. */
  async lockAsManager(spaceId: string, userId: string): Promise<Space> {
    const { space } = await this.access.lockAsMember(
      spaceId,
      userId,
      'space.members.manage',
    );
    return space;
  }

  /** Switching off: the space manager or whoever decides. */
  async lockAsManagerOrDecider(
    spaceId: string,
    userId: string,
  ): Promise<Space> {
    try {
      return await this.lockAsManager(spaceId, userId);
    } catch (e) {
      // Not a member (404) or a member without the permission (403): only a domain refusal falls through to the
      // decider path (no database error, so the transaction is still usable).
      if (!(e instanceof NotFoundError || e instanceof PermissionDeniedError)) {
        throw e;
      }
    }
    return this.lockAsDecider(spaceId, userId);
  }

  /** Reading the cloud state: any member of the space or whoever decides (no lock). */
  async findForViewer(spaceId: string, userId: string): Promise<Space> {
    try {
      return (await this.access.requireSpaceMember(spaceId, userId)).space;
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
    }
    return this.access.requireOrgPermissionForSpace(
      spaceId,
      userId,
      CLOUD_DECIDER_PERMISSION,
    );
  }

  /** People of the space (0 = orphan). Trusted read. */
  memberCount(organizationId: string, spaceId: string): Promise<number> {
    return this.access
      .spaceMemberIds(organizationId, spaceId)
      .then((ids) => ids.length);
  }
}
