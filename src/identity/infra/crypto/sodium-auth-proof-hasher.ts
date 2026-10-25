import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import {
  Injectable,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Piscina } from 'piscina';
import { AuthProofHasher } from '../../application/ports/auth-proof-hasher.js';

const DUMMY_PROOF = 'dummy-auth-proof-for-timing-equalisation';

/** Compiled .js in dist/, .ts when running from sources (Vitest). */
function workerFile(): URL {
  const js = new URL('./argon2.worker.js', import.meta.url);
  return existsSync(js) ? js : new URL('./argon2.worker.ts', import.meta.url);
}

/** Argon2id runs in a worker pool so ~25 ms of CPU per call never blocks the event loop. */
@Injectable()
export class SodiumAuthProofHasher
  extends AuthProofHasher
  implements OnModuleInit, OnModuleDestroy
{
  private pool?: Piscina;
  private dummyHash?: Promise<string>;

  constructor(@Optional() private readonly config?: ConfigService) {
    super();
  }

  /** Creates the pool and warms the dummy hash so the first unknown-email verify costs the same as later ones. */
  async onModuleInit(): Promise<void> {
    this.getPool();
    this.dummyHash ??= this.hash(DUMMY_PROOF);
    await this.dummyHash;
  }

  async onModuleDestroy(): Promise<void> {
    const pool = this.pool;
    this.pool = undefined;
    await pool?.destroy();
  }

  async hash(authProof: string): Promise<string> {
    return (await this.getPool().run({ op: 'hash', authProof })) as string;
  }

  async verify(authHash: string, authProof: string): Promise<boolean> {
    return (await this.getPool().run({
      op: 'verify',
      authHash,
      authProof,
    })) as boolean;
  }

  async verifyAgainstDummy(authProof: string): Promise<false> {
    this.dummyHash ??= this.hash(DUMMY_PROOF);
    await this.verify(await this.dummyHash, authProof);
    return false;
  }

  private getPool(): Piscina {
    if (!this.pool) {
      const size = Number(this.config?.get('ARGON2_POOL_SIZE'));
      const threads =
        Number.isInteger(size) && size >= 1
          ? size
          : Math.min(4, availableParallelism());
      this.pool = new Piscina({
        filename: workerFile().href,
        minThreads: threads,
        maxThreads: threads,
      });
    }
    return this.pool;
  }
}
