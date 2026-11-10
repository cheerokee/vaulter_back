import { Injectable } from '@nestjs/common';

/**
 * One part of a space usage, implemented by the module that stores it (the `storage` backup index, the
 * `conversations` message bodies...): bytes it keeps for the space (live and trash), and the trash part of it (deleted
 * content still inside its 30-day window; absent = 0).
 */
export type SpaceStorageUsageSource = {
  usedBytes(organizationId: string, spaceId: string): Promise<number>;
  trashBytes?(organizationId: string, spaceId: string): Promise<number>;
};

// Porta do uso de um espaço, exportada pelo `spaces`. Quem guarda bytes do espaço (o `storage`, o `conversations`)
// depende do `spaces`, nunca o contrário: cada um REGISTRA a própria fonte em `onModuleInit` (`register(nome, fonte)`)
// e a tira no destroy (`unregister`). O uso é a SOMA das fontes, lidas uma depois da outra (quem chama está dentro de
// um unit of work: uma conexão só, nunca duas consultas ao mesmo tempo). Sem fonte (unitários sem esses módulos), 0.
// Toda regra de "cabe no espaço" (intenção de envio do backup, mensagem do assunto, redimensionar) lê ESTA soma.
@Injectable()
export class SpaceStorageUsage {
  private sources = new Map<string, SpaceStorageUsageSource>();

  register(name: string, source: SpaceStorageUsageSource): void {
    if (this.sources.has(name)) {
      throw new Error(
        `A space storage usage source "${name}" is already registered.`,
      );
    }
    this.sources.set(name, source);
  }

  unregister(name: string): void {
    this.sources.delete(name);
  }

  /**
   * Test seam: swaps every registered source for `source` alone and returns the function that puts the previous ones
   * back. Specs that fake the usage call it and restore in `afterEach`, so the real sources stay bound for the rest of
   * the suite.
   */
  replace(source: SpaceStorageUsageSource): () => void {
    const previous = this.sources;
    this.sources = new Map([['replaced', source]]);
    return () => {
      this.sources = previous;
    };
  }

  async usedBytes(organizationId: string, spaceId: string): Promise<number> {
    let total = 0;
    for (const source of this.sources.values()) {
      total += await source.usedBytes(organizationId, spaceId);
    }
    return total;
  }

  /** The trash part of `usedBytes` (0 without a source): the app warns the Gestor when it is a relevant share. */
  async trashBytes(organizationId: string, spaceId: string): Promise<number> {
    let total = 0;
    for (const source of this.sources.values()) {
      if (source.trashBytes) {
        total += await source.trashBytes(organizationId, spaceId);
      }
    }
    return total;
  }
}
