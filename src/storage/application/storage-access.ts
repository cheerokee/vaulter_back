import { Injectable } from '@nestjs/common';
import { HubDirectory } from '../../hubs/application/hub-directory.js';
import {
  SpaceContentAccess,
  type SpaceContentActor,
  type SpaceContentState,
} from '../../spaces/application/space-content-access.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { STORAGE_LOCK_TIMEOUT_MS } from '../domain/backup-limits.js';
import type { BackupUploader } from '../domain/backup-object-version.js';

/** Who acts on the backup: the hub with its own token, or a person with a user token (any session). */
export type StorageActor = { hubId: string } | { userId: string };

/** `space.members.manage` (Gestor): emptying the trash. */
export type StoragePermission =
  'memory.read' | 'memory.write' | 'memory.delete' | 'space.members.manage';

export function uploaderOf(actor: StorageActor): BackupUploader {
  return 'hubId' in actor ? { hubId: actor.hubId } : { userId: actor.userId };
}

// Quem mexe no backup de um espaço (spec storage-backup §4.2), o mesmo para as rotas com token de Hub e com token de
// usuário:
// - Hub: o espaço na Sala dele, com um papel que tenha a permissão (enviar e apagar = `memory.write`, só
//   `space_editor`). Qualquer recusa = 404 `space-not-found`, sem revelar o espaço. As
//   organizações candidatas são as de vínculo APROVADO do Hub (`HubDirectory`, lidas sem lock).
// - Pessoa: `SpaceAccess` (404 não membro, 403 sem a permissão), com qualquer sessão (decisão da Task 5: o conteúdo
//   é cifrado no cliente e o membro já tem a chave).
// Trava a linha do espaço (FOR UPDATE na intenção, FOR SHARE na confirmação e no apagar; veja `SpaceContentAccess`) e
// reconfere sob ela, com `lock_timeout` de 10 s para o resto da transação (`STORAGE_LOCK_TIMEOUT_MS`). MUST run inside `UnitOfWork.run`. Leituras (listar, URL de download, `memory.read`: qualquer papel
// de Sala e todo membro do espaço) usam `require`, as mesmas respostas sem trava nenhuma.
@Injectable()
export class StorageAccess {
  constructor(
    private readonly content: SpaceContentAccess,
    private readonly hubs: HubDirectory,
    private readonly uow: UnitOfWork,
  ) {}

  /** Reads (listing, download URLs): the same answers as `lock`, without any lock and without a unit of work. */
  async require(
    spaceId: string,
    actor: StorageActor,
    permission: StoragePermission,
  ): Promise<SpaceContentState> {
    return this.content.requireForContent(
      spaceId,
      await this.contentActor(actor),
      permission,
    );
  }

  /** `mode`: `update` for the upload intent (reserves usage), `share` for confirmations and deletes. */
  async lock(
    spaceId: string,
    actor: StorageActor,
    permission: StoragePermission,
    mode: 'update' | 'share' = 'update',
  ): Promise<SpaceContentState> {
    // Toda espera por trava desta transação (espaço e, depois, objetos) é limitada: 55P03 vira 409 `storage-busy`
    // nos casos de uso (`lockTimeoutAsBusy`), em vez de o pedido segurar uma conexão do pool atrás de um lote longo.
    await this.uow.setLockTimeout(STORAGE_LOCK_TIMEOUT_MS);
    return this.content.lockForContent(
      spaceId,
      await this.contentActor(actor),
      permission,
      mode,
    );
  }

  private async contentActor(actor: StorageActor): Promise<SpaceContentActor> {
    if ('userId' in actor) return { kind: 'user', userId: actor.userId };
    return {
      kind: 'hub',
      hubId: actor.hubId,
      organizationIds: await this.hubs.approvedOrganizationIds(actor.hubId),
    };
  }
}
