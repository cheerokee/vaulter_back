import { Injectable } from '@nestjs/common';

/** What one reconciler did (counts only, e.g. `{ attachments, removedVersions }`). */
export type StorageReconcileResult = Record<string, number>;

export type StorageReconcileHook = {
  name: string;
  /** Repairs every index row of the module whose S3 write mark is older than `olderThanMinutes` (database clock). */
  reconcile(olderThanMinutes: number): Promise<StorageReconcileResult>;
};

// Registro global das outras varreduras do reparo do bucket (índice × S3): o `storage:reconcile` (CLI do `storage`)
// repara o índice do backup e depois roda cada gancho registrado aqui, sem o `storage` conhecer o módulo dono do índice
// (hoje: `conversations.attachments`, os anexos dos assuntos). Em sequência, na ordem de registro; o erro de um sobe
// (cada reparo por linha já é "nunca lança": as marcas ficam para a próxima varredura).
@Injectable()
export class StorageReconcileHooks {
  private readonly hooks: StorageReconcileHook[] = [];

  register(hook: StorageReconcileHook): void {
    if (this.hooks.some((h) => h.name === hook.name)) {
      throw new Error(
        `Storage reconcile hook "${hook.name}" is already registered.`,
      );
    }
    this.hooks.push(hook);
  }

  unregister(name: string): void {
    const i = this.hooks.findIndex((h) => h.name === name);
    if (i >= 0) this.hooks.splice(i, 1);
  }

  async run(
    olderThanMinutes: number,
  ): Promise<Record<string, StorageReconcileResult>> {
    const out: Record<string, StorageReconcileResult> = {};
    for (const hook of this.hooks) {
      out[hook.name] = await hook.reconcile(olderThanMinutes);
    }
    return out;
  }
}
