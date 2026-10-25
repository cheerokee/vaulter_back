import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import {
  Injectable,
  Optional,
  ServiceUnavailableException,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Piscina } from 'piscina';
import { AuthProofHasher } from '../../application/ports/auth-proof-hasher.js';
import type { Argon2Job } from './argon2.worker.js';

const QUEUE_FULL_MESSAGE = 'Task queue is at limit';
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
  implements OnModuleInit, OnApplicationShutdown
{
  private pool?: Piscina;
  private dummyHash?: Promise<string>;
  private destroyed = false;

  constructor(@Optional() private readonly config?: ConfigService) {
    super();
  }

  /** Creates the pool and warms the dummy hash so the first unknown-email verify costs the same as later ones. */
  async onModuleInit(): Promise<void> {
    this.getPool();
    await this.getDummyHash();
  }

  /**
   * Destroyed on application shutdown (after the HTTP server stopped accepting and draining requests),
   * not on module destroy, so in-flight logins are not killed mid-hash.
   */
  async onApplicationShutdown(): Promise<void> {
    const pool = this.pool;
    this.pool = undefined;
    this.destroyed = true;
    await pool?.destroy();
  }

  async hash(authProof: string): Promise<string> {
    return (await this.run({ op: 'hash', authProof })) as string;
  }

  async verify(authHash: string, authProof: string): Promise<boolean> {
    return (await this.run({ op: 'verify', authHash, authProof })) as boolean;
  }

  async verifyAgainstDummy(authProof: string): Promise<false> {
    await this.verify(await this.getDummyHash(), authProof);
    return false;
  }

  /** Queue-full rejections become a 503 (the filter hides the detail); other errors pass through. */
  private async run(job: Argon2Job): Promise<string | boolean> {
    try {
      return (await this.getPool().run(job)) as string | boolean;
    } catch (error) {
      if (error instanceof Error && error.message === QUEUE_FULL_MESSAGE) {
        throw new ServiceUnavailableException();
      }
      throw error;
    }
  }

  /** Cached dummy hash; a rejected attempt is dropped so a transient failure is retried. */
  private getDummyHash(): Promise<string> {
    if (!this.dummyHash) {
      const attempt = this.hash(DUMMY_PROOF);
      this.dummyHash = attempt;
      attempt.catch(() => {
        if (this.dummyHash === attempt) this.dummyHash = undefined;
      });
    }
    return this.dummyHash;
  }

  private getPool(): Piscina {
    if (this.destroyed) {
      throw new Error('SodiumAuthProofHasher has been destroyed');
    }
    if (!this.pool) {
      const size = Number(this.config?.get('ARGON2_POOL_SIZE'));
      const threads =
        Number.isInteger(size) && size >= 1
          ? size
          : Math.min(4, availableParallelism());
      // Bounded queue: ~64 waiting hashes per thread (each ~25 ms of worker time, so ~1.6 s of backlog);
      // beyond that we shed load with 503 instead of letting memory and latency grow without limit.
      const queue = Number(this.config?.get('ARGON2_MAX_QUEUE'));
      const maxQueue =
        Number.isInteger(queue) && queue >= 1 ? queue : threads * 64;
      this.pool = new Piscina({
        maxQueue,
        filename: workerFile().href,
        minThreads: threads,
        maxThreads: threads,
      });
    }
    return this.pool;
  }
}
