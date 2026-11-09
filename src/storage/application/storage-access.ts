import { Injectable } from '@nestjs/common';
import { HubDirectory } from '../../hubs/application/hub-directory.js';
import {
  SpaceContentAccess,
  type SpaceContentState,
} from '../../spaces/application/space-content-access.js';
import type { BackupUploader } from '../domain/backup-object-version.js';

/** Who acts on the backup: the hub with its own token, or a person with a user token (any session). */
export type StorageActor = { hubId: string } | { userId: string };

export type StoragePermission =
  'memory.read' | 'memory.write' | 'memory.delete';

export function uploaderOf(actor: StorageActor): BackupUploader {
  return 'hubId' in actor ? { hubId: actor.hubId } : { userId: actor.userId };
}

// Quem mexe no backup de um espaço (spec storage-backup §4.2), o mesmo para as rotas com token de Hub e com token de
// usuário:
// - Hub: o espaço na Sala dele, com um papel que tenha a permissão (enviar = `memory.write`, só `space_editor`; apagar
//   = `memory.delete`, que Sala nenhuma tem). Qualquer recusa = 404 `space-not-found`, sem revelar o espaço. As
//   organizações candidatas são as de vínculo APROVADO do Hub (`HubDirectory`, lidas sem lock).
// - Pessoa: `SpaceAccess` (404 não membro, 403 sem a permissão), com qualquer sessão (decisão da Task 5: o conteúdo
//   é cifrado no cliente e o membro já tem a chave).
// Trava a linha do espaço FOR UPDATE (a mesma do redimensionar e da troca de chave) e reconfere sob ela. MUST run
// inside `UnitOfWork.run`.
@Injectable()
export class StorageAccess {
  constructor(
    private readonly content: SpaceContentAccess,
    private readonly hubs: HubDirectory,
  ) {}

  async lock(
    spaceId: string,
    actor: StorageActor,
    permission: StoragePermission,
  ): Promise<SpaceContentState> {
    if ('userId' in actor) {
      return this.content.lockForContent(
        spaceId,
        { kind: 'user', userId: actor.userId },
        permission,
      );
    }
    return this.content.lockForContent(
      spaceId,
      {
        kind: 'hub',
        hubId: actor.hubId,
        organizationIds: await this.hubs.approvedOrganizationIds(actor.hubId),
      },
      permission,
    );
  }
}
