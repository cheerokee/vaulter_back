import { Injectable } from '@nestjs/common';

export type BackupObjectsChangedContext = {
  organizationId: string;
  spaceId: string;
  /** Objects that gained a committed version (`committed`) or a tombstone (`deleted`) in this unit of work. */
  objectIds: readonly string[];
  change: 'committed' | 'deleted';
};

export type BackupObjectsChangedHook = {
  name: string;
  onBackupObjectsChanged(ctx: BackupObjectsChangedContext): Promise<void>;
};

// Registro global de quem reage a uma mudança no backup de um espaço (confirmação de envio, apagar), sem o `storage`
// conhecê-lo. O `cloud` assina: num espaço em nuvem ativa, enfileira a (re)indexação. Mesma regra dos outros ganchos:
// assina em `onModuleInit`, roda em sequência DENTRO do unit of work do `storage`, depois das gravações do índice, com
// o espaço travado `FOR SHARE` (a ordem de travas do `storage` fica intacta: um gancho não trava nada; enfileirar uma
// tarefa entra na mesma transação); erro de um desfaz a confirmação / o apagar. Só ids (nada legível existe aqui).
@Injectable()
export class BackupObjectsChangedHooks {
  private readonly hooks: BackupObjectsChangedHook[] = [];

  register(hook: BackupObjectsChangedHook): void {
    if (this.hooks.some((h) => h.name === hook.name)) {
      throw new Error(
        `Backup-objects-changed hook "${hook.name}" is already registered.`,
      );
    }
    this.hooks.push(hook);
  }

  unregister(name: string): void {
    const i = this.hooks.findIndex((h) => h.name === name);
    if (i >= 0) this.hooks.splice(i, 1);
  }

  async run(ctx: BackupObjectsChangedContext): Promise<void> {
    if (ctx.objectIds.length === 0) return;
    for (const hook of this.hooks) await hook.onBackupObjectsChanged(ctx);
  }
}
