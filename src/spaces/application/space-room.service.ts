import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import {
  NotFoundError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { KeyRotationRules } from '../domain/key-rotation.js';
import { SpaceKeyRepository } from '../domain/space-key.repository.js';
import {
  SpaceMembershipRules,
  type SpaceRoleKey,
} from '../domain/space-membership.js';
import { SpaceRoleRepository } from '../domain/space-role.repository.js';
import { SpaceRoomRepository } from '../domain/space-room.repository.js';
import type { Space } from '../domain/space.js';
import { SpaceRepository } from '../domain/space.repository.js';
import { assertWrappedKeys, type VersionGrantInput } from './dto/key-inputs.js';
import { RecoveryKit } from './recovery-kit.js';
import { SpaceAccess } from './space-access.js';

export type GrantRoomInput = {
  hubId: string;
  spaceId: string;
  /** Role of the Room in the space: space_reader (default) or space_editor. */
  roleKey?: string;
  /** The kit the app used; must be the organization's current one (like every kit-aware write). */
  recoveryPublicKey: string;
  /** Every key version, sealed for the hub's encryption public key (checked by the caller). */
  grants: VersionGrantInput[];
  /**
   * Supplied by the `hubs` module: confirms (and may lock, e.g. `FOR SHARE`) that the hub is linked and approved
   * to `organizationId`, the space's organization, and throws to refuse. Runs inside the unit of work AFTER the
   * actor's access pre-check and BEFORE the space lock (lock order: hub link row, then spaces — the same order as
   * unlinking, which then calls `revokeRoomForOrganization`).
   */
  confirmHubLink: (organizationId: string) => Promise<void>;
};

/**
 * Who takes a space out of a Room:
 * - `space_manager`: checked here (Gestor of the space; 404/403 like every space mutation);
 * - `trusted`: the caller already authorized it (hub owner on `DELETE .../room`, the space-left hook, ...) and
 *   knows the space's organization; `actorId` goes to the audit (null for the system).
 */
export type RoomRevoker =
  | { kind: 'space_manager'; userId: string }
  | { kind: 'trusted'; organizationId: string; actorId: string | null };

export type RoomRevokeReason =
  'revoked' | 'owner_left_space' | 'hub_unlinked' | 'hub_deregistered';

export type BulkRoomRevocation = {
  hubId: string;
  actorId: string | null;
  reason: RoomRevokeReason;
};

function hubNotFound(): NotFoundError {
  return new NotFoundError('hub-not-found', 'The hub was not found.');
}

function roomNotFound(): NotFoundError {
  return new NotFoundError(
    'room-not-found',
    'The space is not open in the room of this hub.',
  );
}

// Sala dos Hubs vista pelo `spaces` (spec hubs §4.8 e §6, decisão 7 do plano). O `spaces` não conhece a tabela
// `hubs`: recebe o id do Hub e a confirmação do vínculo de quem chama (o módulo `hubs`), e só valida o formato
// das cópias e as contagens — a cópia é selada para a chave do Hub e não dá para conferir aqui.
// - Liberar: Gestor do espaço, política da organização (`allow_room_spaces`), kit atual, cópia de TODAS as
//   versões, e o assento conta no `SPACE_MAX_MEMBERS` (pessoas + Hubs). Liberar de novo um Hub que já está na
//   Sala troca o papel e as cópias, sem contar outro assento.
// - Tirar: lápide no papel e nas cópias do Hub e troca de chave pendente (o Hub guardou a chave).
// Tudo com o espaço travado (`FOR UPDATE`); as revogações em lote travam os espaços em ordem de id antes das
// lápides, como o gancho de saída da organização. Nenhuma auditoria leva cópia trancada.
@Injectable()
export class SpaceRoomService {
  constructor(
    private readonly access: SpaceAccess,
    private readonly kit: RecoveryKit,
    private readonly directory: OrganizationDirectory,
    private readonly spaces: SpaceRepository,
    private readonly keys: SpaceKeyRepository,
    private readonly roles: SpaceRoleRepository,
    private readonly room: SpaceRoomRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  async grantRoom(
    actor: Actor,
    input: GrantRoomInput,
  ): Promise<{ hubId: string; spaceId: string; roleKey: SpaceRoleKey }> {
    const roleKey = SpaceMembershipRules.assertRoomRole(
      input.roleKey ?? 'space_reader',
    );
    assertWrappedKeys(input.grants.map((g) => g.wrappedKey));
    if (!validate(input.hubId)) throw hubNotFound();
    return this.uow.run(async () => {
      const { space } = await this.access.lockAsMember(
        input.spaceId,
        actor.userId,
        'space.members.manage',
        (orgId) => input.confirmHubLink(orgId),
      );
      const orgId = space.organizationId;
      if (!(await this.directory.allowRoomSpaces(orgId))) {
        throw new PermissionDeniedError(
          'room-spaces-disabled',
          'The organization does not allow spaces in a hub room.',
        );
      }
      await this.kit.assertCurrent(orgId, input.recoveryPublicKey);
      // Contado com o espaço travado: pôr membro e liberar na Sala passam pelo mesmo lock.
      const roomHubs = await this.room.roomHubIds(orgId, space.id);
      if (!roomHubs.includes(input.hubId)) {
        const people = await this.roles.activeMemberIds(orgId, space.id);
        SpaceMembershipRules.assertCanAddMember(
          people.length + roomHubs.length,
        );
      }
      const versions = await this.keys.versions(orgId, space.id);
      KeyRotationRules.assertGrantsCoverVersions(
        input.grants.map((g) => g.version),
        versions.map((v) => v.version),
      );
      const byVersion = new Map(versions.map((v) => [v.version, v.id]));
      for (const grant of input.grants) {
        await this.room.upsertHubGrant(
          orgId,
          byVersion.get(grant.version)!,
          input.hubId,
          grant.wrappedKey,
        );
      }
      await this.room.assignRoom(
        orgId,
        space.id,
        input.hubId,
        roleKey,
        actor.userId,
      );
      await this.audit.record({
        organizationId: orgId,
        userId: actor.userId,
        action: 'hub.room.granted',
        metadata: { spaceId: space.id, hubId: input.hubId, roleKey },
      });
      return { hubId: input.hubId, spaceId: space.id, roleKey };
    });
  }

  /**
   * Takes one space out of the hub's Room. `space_manager`: 404 `room-not-found` when the hub is not in the
   * Room. `trusted`: false when there was nothing to revoke (unknown space, another organization, not in the
   * Room), so hooks stay idempotent. Runs in the caller's unit of work when there is one.
   */
  async revokeRoom(
    revoker: RoomRevoker,
    input: { hubId: string; spaceId: string; reason: RoomRevokeReason },
  ): Promise<boolean> {
    if (revoker.kind === 'space_manager') {
      return this.uow.run(async () => {
        const { space } = await this.access.lockAsMember(
          input.spaceId,
          revoker.userId,
          'space.members.manage',
        );
        if (
          !validate(input.hubId) ||
          !(await this.room.removeRoom(
            space.organizationId,
            space.id,
            input.hubId,
          ))
        ) {
          throw roomNotFound();
        }
        await this.afterRevoke(
          space,
          input.hubId,
          revoker.userId,
          input.reason,
        );
        return true;
      });
    }
    const orgId = revoker.organizationId;
    if (![orgId, input.spaceId, input.hubId].every((id) => validate(id))) {
      return false;
    }
    return this.uow.run(async () => {
      const space = await this.spaces.lockForUpdate(orgId, input.spaceId);
      if (!space) return false;
      if (!(await this.room.removeRoom(orgId, space.id, input.hubId))) {
        return false;
      }
      await this.afterRevoke(space, input.hubId, revoker.actorId, input.reason);
      return true;
    });
  }

  /**
   * Unlinking an organization: takes every space of `organizationId` out of the hub's Room. Locks the spaces
   * (`FOR UPDATE`, id order) before the tombstones; a space reached only by the tombstone (a grant that committed
   * in between) is locked too. Returns the affected space ids. Meant to run inside the caller's unit of work.
   */
  async revokeRoomForOrganization(
    input: BulkRoomRevocation & { organizationId: string },
  ): Promise<string[]> {
    const { organizationId: orgId, hubId } = input;
    if (!validate(orgId) || !validate(hubId)) return [];
    return this.uow.run(async () => {
      const locked = new Map<string, Space | null>();
      const affected = new Set<string>();
      let toLock = await this.room.roomSpaceIdsOfHub(orgId, hubId);
      if (toLock.length === 0) return [];
      for (;;) {
        for (const id of [...toLock].sort()) {
          if (!locked.has(id)) {
            locked.set(id, await this.spaces.lockForUpdate(orgId, id));
          }
        }
        const touched = await this.room.removeHubInOrg(orgId, hubId);
        for (const id of touched) affected.add(id);
        toLock = touched.filter((id) => !locked.has(id));
        if (toLock.length === 0) break;
      }
      const ids = [...affected].sort();
      for (const id of ids) {
        const space = locked.get(id);
        if (space)
          await this.afterRevoke(space, hubId, input.actorId, input.reason);
      }
      return ids;
    });
  }

  /**
   * Deregistering a hub: `revokeRoomForOrganization` for each given organization (every organization the hub
   * was ever linked to: the Room rows are under each organization's RLS), in id order, in one unit of work.
   */
  async revokeAllRoomForHub(
    input: BulkRoomRevocation & { organizationIds: readonly string[] },
  ): Promise<string[]> {
    const orgIds = [...new Set(input.organizationIds)].sort();
    return this.uow.run(async () => {
      const ids: string[] = [];
      for (const organizationId of orgIds) {
        ids.push(
          ...(await this.revokeRoomForOrganization({
            hubId: input.hubId,
            actorId: input.actorId,
            reason: input.reason,
            organizationId,
          })),
        );
      }
      return ids;
    });
  }

  private async afterRevoke(
    space: Space,
    hubId: string,
    actorId: string | null,
    reason: RoomRevokeReason,
  ): Promise<void> {
    space.markRotationRequired();
    await this.spaces.save(space);
    await this.audit.record({
      organizationId: space.organizationId,
      userId: actorId,
      action: 'hub.room.revoked',
      metadata: { spaceId: space.id, hubId, reason },
    });
  }
}
