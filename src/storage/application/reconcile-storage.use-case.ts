import { Injectable } from '@nestjs/common';
import { BackupObjectVersionRepository } from '../domain/backup-object-version.repository.js';
import { BackupObjectHealer } from './backup-object-healer.js';

/** Write marks older than this are considered abandoned (no request holds an object lock that long). */
export const RECONCILE_DEFAULT_AGE_MINUTES = 60;

// Varredura do reparo (`npm run storage:reconcile`, agendada fora da aplicação por enquanto — sem pg-boss ainda): todo
// objeto com uma marca de gravação no S3 mais antiga que `olderThanMinutes` é reparado (`BackupObjectHealer.repair`),
// cobrindo os objetos em que ninguém mexe de novo depois de uma queda entre o S3 e o COMMIT. Os candidatos são lidos
// no contexto `storageReconcile` (só linhas marcadas, de qualquer organização); o reparo roda no escopo de cada uma.
@Injectable()
export class ReconcileStorageUseCase {
  constructor(
    private readonly versions: BackupObjectVersionRepository,
    private readonly healer: BackupObjectHealer,
  ) {}

  async execute(
    input: { olderThanMinutes?: number } = {},
    now: Date = new Date(),
  ): Promise<{ objects: number; removedVersions: number }> {
    const age = input.olderThanMinutes ?? RECONCILE_DEFAULT_AGE_MINUTES;
    const refs = await this.versions.staleWriteMarks(
      new Date(now.getTime() - age * 60_000),
    );
    return {
      objects: refs.length,
      removedVersions: await this.healer.repair(refs),
    };
  }
}
