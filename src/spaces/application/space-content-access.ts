import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { NotFoundError } from '../../shared/domain/errors.js';
import {
  hasSpacePermission,
  type SpacePermission,
} from '../domain/space-membership.js';
import { SpaceRoomRepository } from '../domain/space-room.repository.js';
import type { Space } from '../domain/space.js';
import { SpaceRepository } from '../domain/space.repository.js';
import { SpaceAccess } from './space-access.js';

/**
 * Who touches the content of a space (the encrypted backup, module `storage`):
 * - `user`: a member of the space (any session; `SpaceAccess`: 404 non-member, 403 without the permission);
 * - `hub`: a hub with the space in its Room. `organizationIds` = the organizations with an APPROVED link to the hub,
 *   given by the caller (the `hubs` module); the space must be in one of them.
 */
export type SpaceContentActor =
  | { kind: 'user'; userId: string }
  | { kind: 'hub'; hubId: string; organizationIds: readonly string[] };

/** What the backup needs of the locked space. */
export type SpaceContentState = {
  organizationId: string;
  spaceId: string;
  currentKeyVersion: number;
  keyRotationRequired: boolean;
  storageQuotaBytes: number;
};

function spaceNotFound(): NotFoundError {
  return new NotFoundError('space-not-found', 'The space was not found.');
}

function stateOf(space: Space): SpaceContentState {
  return {
    organizationId: space.organizationId,
    spaceId: space.id,
    currentKeyVersion: space.currentKeyVersion,
    keyRotationRequired: space.keyRotationRequired,
    storageQuotaBytes: space.storageQuotaBytes,
  };
}

// Acesso ao CONTEÚDO de um espaço (spec storage-backup §4.2), exportado para o `storage`.
// - Pessoa: `SpaceAccess.lockAsMember` (404 para não membro, 403 para membro sem a permissão).
// - Hub: a Sala dele no espaço (role_assignments com room_hub_id) com um papel que tenha a permissão. Sala de
//   leitor, sem Sala, organização sem vínculo aprovado, espaço de outra organização, id malformado: SEMPRE o mesmo
//   404 `space-not-found` (um Hub nunca descobre que o espaço existe nem recebe 403). A Sala só existe com o espaço
//   no Hub e o vínculo aprovado (tirar o espaço do Hub, desvincular e desregistrar derrubam a Sala), então ela basta.
// Trava a linha do espaço e reconfere o papel sob ela. `mode`:
// - `update` (FOR UPDATE, a MESMA trava do redimensionar, da troca de chave, de pôr/tirar membro e de tirar da Sala):
//   a intenção de envio, que lê o uso e reserva — duas intenções do mesmo espaço se serializam (senão as duas caberiam
//   sozinhas e juntas estourariam o tamanho);
// - `share` (FOR SHARE): confirmação e apagar, que não aumentam o uso (a reserva já está nele) mas fazem chamadas ao
//   S3 sob a trava. Ainda serializam com tudo que trava FOR UPDATE (um encolhimento ou uma troca de chave esperam o
//   lote terminar, e vice-versa); entre si, a ordem é pela trava das linhas dos objetos.
// Um Hub tirado da Sala no meio não grava (tirar da Sala trava FOR UPDATE). Nada é travado antes do espaço (as
// leituras do vínculo do Hub são sem lock), então a ordem Hub -> vínculo -> hub_space -> espaço vale.
// MUST run inside `UnitOfWork.run`.
@Injectable()
export class SpaceContentAccess {
  constructor(
    private readonly access: SpaceAccess,
    private readonly spaces: SpaceRepository,
    private readonly room: SpaceRoomRepository,
  ) {}

  async lockForContent(
    spaceId: string,
    actor: SpaceContentActor,
    permission: SpacePermission,
    mode: 'update' | 'share' = 'update',
  ): Promise<SpaceContentState> {
    if (actor.kind === 'user') {
      const { space } = await this.access.lockAsMember(
        spaceId,
        actor.userId,
        permission,
        undefined,
        mode,
      );
      return stateOf(space);
    }
    if (!validate(spaceId) || !validate(actor.hubId)) throw spaceNotFound();
    const orgId = await this.organizationOfRoom(spaceId, actor, permission);
    const space =
      mode === 'share'
        ? await this.spaces.lockForShare(orgId, spaceId)
        : await this.spaces.lockForUpdate(orgId, spaceId);
    if (
      !space ||
      !(await this.roomAllows(orgId, spaceId, actor.hubId, permission))
    ) {
      throw spaceNotFound();
    }
    return stateOf(space);
  }

  /** Pre-check without lock: the linked organization holding the space, with a Room role that allows it. */
  private async organizationOfRoom(
    spaceId: string,
    actor: { hubId: string; organizationIds: readonly string[] },
    permission: SpacePermission,
  ): Promise<string> {
    for (const orgId of [...new Set(actor.organizationIds)].sort()) {
      if (!validate(orgId)) continue;
      if (!(await this.spaces.findById(orgId, spaceId))) continue;
      if (await this.roomAllows(orgId, spaceId, actor.hubId, permission)) {
        return orgId;
      }
      break; // A space belongs to one organization only.
    }
    throw spaceNotFound();
  }

  private async roomAllows(
    orgId: string,
    spaceId: string,
    hubId: string,
    permission: SpacePermission,
  ): Promise<boolean> {
    const room = (await this.room.roomHubs(orgId, spaceId)).find(
      (r) => r.hubId === hubId,
    );
    return Boolean(room && hasSpacePermission(room.roleKey, permission));
  }
}
