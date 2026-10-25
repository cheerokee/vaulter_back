import type { ThrottlerStorage } from '@nestjs/throttler';
import type { DataSource } from 'typeorm';

type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;

export interface PostgresThrottlerStorageOptions {
  /** Chance (0..1) that a call also deletes expired rows. Default 1%. */
  cleanupProbability?: number;
}

/**
 * One atomic upsert per hit, so every app instance shares the same counters (table `rate_limit_hits`,
 * UNLOGGED, see its migration). Fixed window: the first hit opens a window of `ttl` ms; going past
 * `limit` blocks the key for `blockDuration` ms, and hits during a block are not counted. When a window
 * or a block has ended, the next hit starts a fresh window. `ttl`/`blockDuration` are in milliseconds
 * (throttler v6); the returned times are in seconds, as the library expects (they feed Retry-After).
 * The table is deliberately not a TypeORM entity: it is a technical counter outside the schema model.
 */
export class PostgresThrottlerStorage implements ThrottlerStorage {
  private readonly cleanupProbability: number;

  constructor(
    private readonly dataSource: DataSource,
    options: PostgresThrottlerStorageOptions = {},
  ) {
    this.cleanupProbability = options.cleanupProbability ?? 0.01;
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    // active: a block is running. fresh: the window or the block ended, so this hit restarts the count.
    const active = `rate_limit_hits.blocked_until > now()`;
    const fresh = `(rate_limit_hits.expires_at <= now() OR rate_limit_hits.blocked_until IS NOT NULL)`;
    const nextHits = `CASE WHEN ${active} THEN rate_limit_hits.hits WHEN ${fresh} THEN 1 ELSE rate_limit_hits.hits + 1 END`;
    const rows: {
      hits: number;
      is_blocked: boolean;
      expires_in: string;
      block_in: string;
    }[] = await this.dataSource.query(
      `INSERT INTO rate_limit_hits (key, hits, expires_at, blocked_until)
       VALUES ($1, 1, now() + $2 * interval '1 millisecond',
               CASE WHEN 1 > $3 THEN now() + $4 * interval '1 millisecond' END)
       ON CONFLICT (key) DO UPDATE SET
         hits = ${nextHits},
         expires_at = CASE WHEN ${active} OR NOT ${fresh} THEN rate_limit_hits.expires_at
                           ELSE now() + $2 * interval '1 millisecond' END,
         blocked_until = CASE WHEN ${active} THEN rate_limit_hits.blocked_until
                              WHEN ${nextHits} > $3 THEN now() + $4 * interval '1 millisecond' END
       RETURNING hits,
         (blocked_until IS NOT NULL AND blocked_until > now()) AS is_blocked,
         GREATEST(0, CEIL(EXTRACT(EPOCH FROM (expires_at - now()))))::text AS expires_in,
         GREATEST(0, CEIL(EXTRACT(EPOCH FROM (COALESCE(blocked_until, now()) - now()))))::text AS block_in`,
      [`${throttlerName}:${key}`, ttl, limit, blockDuration],
    );
    const row = rows[0]!;
    if (Math.random() < this.cleanupProbability) {
      void this.cleanup().catch(() => undefined); // housekeeping only: never fails the request
    }
    return {
      totalHits: row.hits,
      timeToExpire: Number(row.expires_in),
      isBlocked: row.is_blocked,
      timeToBlockExpire: Number(row.block_in),
    };
  }

  private async cleanup(): Promise<void> {
    await this.dataSource.query(
      `DELETE FROM rate_limit_hits
       WHERE expires_at < now() AND (blocked_until IS NULL OR blocked_until < now())`,
    );
  }
}
