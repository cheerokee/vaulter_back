import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { uploadKey } from '../domain/backup-keys.js';
import { ConfirmUploadsUseCase } from './confirm-uploads.use-case.js';
import type { CommittedVersionView } from './dto/backup-views.js';
import { ObjectStore } from './ports/object-store.js';
import { RequestUploadsUseCase } from './request-uploads.use-case.js';
import type { BackupWriteGuard } from './server-write-guard.js';

/** One object the server writes: the encrypted blob (`docs/crypto/space-backup.md`) and the version it replaces. */
export type ServerBackupObject = {
  objectId: string;
  keyVersion: number;
  blob: Uint8Array;
  /** The object's current version (null for a new object): 409 `object-version-conflict` if it moved meanwhile. */
  replacesVersionId: string | null;
};

// O servidor gravando no backup de um espaço (nuvem ativa, spec active-cloud §4.2/§4.3: os documentos que a nuvem grava
// e o manifesto da nuvem, cujo id é reservado ao servidor). É o MESMO caminho de um envio de cliente, com o servidor no
// lugar do cliente: intenção (`RequestUploadsUseCase`: espaço FOR UPDATE, troca de chave pendente / versão da chave 409,
// uso do espaço 422 `space-storage-full`), PUT do blob pelo próprio servidor no provisório (`ObjectStore.put`, mesma tag
// `stage=upload`) e confirmação (`ConfirmUploadsUseCase`: diário, cópia sob a trava, índice, reparo,
// `BackupObjectsChangedHooks`). Tudo ou nada por chamada (a confirmação é um unit of work só). Em nome de uma PESSOA
// (`onBehalfOfUserId`, que precisa de `memory.write` no espaço: 404/403 como nas rotas): o envio fica registrado como
// dela (quem confirmou a gravação). `guard` roda nas duas transações logo depois de travar o espaço (ex.: o espaço
// ainda está em nuvem ativa); falso = 409 `server-write-refused`, nada gravado. Nunca chamar dentro de um unit of work
// aberto (as duas transações são próprias e o PUT no S3 roda entre elas, sem conexão presa).
@Injectable()
export class ServerBackupWriter {
  constructor(
    private readonly request: RequestUploadsUseCase,
    private readonly confirm: ConfirmUploadsUseCase,
    private readonly store: ObjectStore,
  ) {}

  async write(input: {
    onBehalfOfUserId: string;
    spaceId: string;
    objects: readonly ServerBackupObject[];
    guard: BackupWriteGuard;
  }): Promise<CommittedVersionView[]> {
    const actor = { userId: input.onBehalfOfUserId };
    let organizationId: string | null = null;
    const guard: BackupWriteGuard = async (space) => {
      organizationId = space.organizationId;
      return input.guard(space);
    };
    const sha = new Map(
      input.objects.map((o) => [
        o.objectId,
        createHash('sha256').update(o.blob).digest('hex'),
      ]),
    );
    const intents = await this.request.execute(
      actor,
      input.spaceId,
      input.objects.map((o) => ({
        objectId: o.objectId,
        keyVersion: o.keyVersion,
        sizeBytes: o.blob.byteLength,
        sha256: sha.get(o.objectId)!,
        replacesVersionId: o.replacesVersionId,
      })),
      new Date(),
      { guard },
    );
    const byObject = new Map(input.objects.map((o) => [o.objectId, o]));
    for (const intent of intents) {
      await this.store.put(
        uploadKey(organizationId!, input.spaceId, intent.uploadId),
        byObject.get(intent.objectId)!.blob,
        sha.get(intent.objectId)!,
      );
    }
    return this.confirm.execute(
      actor,
      input.spaceId,
      intents.map((i) => i.uploadId),
      new Date(),
      { guard },
    );
  }
}
