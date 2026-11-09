import { Injectable } from '@nestjs/common';

/** What the `storage` module implements: every stored version of the space (live, old and in the trash), in bytes. */
export type SpaceStorageUsageSource = {
  usedBytes(organizationId: string, spaceId: string): Promise<number>;
};

// Porta do uso de um espaço, exportada pelo `spaces`. O índice dos objetos é do `storage` (que depende do `spaces`,
// nunca o contrário), então o `storage` LIGA a implementação real em `onModuleInit` (`use`) e a desliga no destroy
// (`release`). Sem fonte ligada (unitários sem o `storage`), o uso é 0.
@Injectable()
export class SpaceStorageUsage {
  private source: SpaceStorageUsageSource | null = null;

  use(source: SpaceStorageUsageSource): void {
    if (this.source) {
      throw new Error('A space storage usage source is already bound.');
    }
    this.source = source;
  }

  release(): void {
    this.source = null;
  }

  /**
   * Test seam: swaps whatever is bound (the real `storage` source in the app) for `source` and returns the function
   * that puts the previous one back. Specs that fake the usage call it and restore in `afterEach`, so the real source
   * stays bound for the rest of the suite.
   */
  replace(source: SpaceStorageUsageSource): () => void {
    const previous = this.source;
    this.source = source;
    return () => {
      this.source = previous;
    };
  }

  usedBytes(organizationId: string, spaceId: string): Promise<number> {
    return this.source
      ? this.source.usedBytes(organizationId, spaceId)
      : Promise.resolve(0);
  }
}
