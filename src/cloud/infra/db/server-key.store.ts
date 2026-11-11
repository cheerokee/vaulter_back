import { Injectable } from '@nestjs/common';
import { DataSource, IsNull, Not } from 'typeorm';
import {
  currentManager,
  hasActiveTransaction,
  runInTransaction,
} from '../../../shared/infra/db/unit-of-work.js';
import { CloudServerKeyTypeormEntity } from './server-key.entity.js';

export interface StoredServerKey {
  publicKey: string;
  encryptedPrivateKey: string;
  kmsKeyArn: string;
}

// Advisory lock key (any constant bigint unique in the codebase): serializes the first-key generation across
// instances, so two instances booting together never create two current keys.
const GENERATION_LOCK = 7_310_221_901;

/** Rows of `cloud_server_keys`. Infra detail of `KmsServerKeyring` (no domain contract: there is no rule here). */
@Injectable()
export class ServerKeyTypeormStore {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * The current key, or the one `generate` produces when there is none, in a transaction of its OWN (holding the
   * generation lock; the check is repeated under it) that is COMMITTED before this returns: the caller only ever sees
   * (and caches) a key that exists in the table. Refused inside an open unit of work: joining the caller's transaction
   * would let a rollback erase a key already handed out (a "phantom" key), and a transaction of its own there would
   * need a second pool connection while the caller holds one. `generate` calls KMS inside this short transaction,
   * holding the lock and a connection: a documented exception to "external calls after the run", because the row must
   * be created under the lock that keeps a single current key; it happens once per key (first use, rotation).
   */
  async currentOrCreate(
    generate: () => Promise<StoredServerKey>,
  ): Promise<StoredServerKey> {
    if (this.inTransaction()) {
      throw new Error(
        'server key: a key is never created inside a unit of work (call publicKey() outside UnitOfWork.run).',
      );
    }
    const existing = await this.current();
    if (existing) return existing;
    return runInTransaction(this.dataSource, async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1)', [
        GENERATION_LOCK,
      ]);
      const repo = manager.getRepository(CloudServerKeyTypeormEntity);
      const again = await repo.findOne({ where: { retiredAt: IsNull() } });
      if (again) return toStored(again);
      const created = await generate();
      await repo.insert({ ...created, retiredAt: null });
      return created;
    });
  }

  /** Whether the caller runs inside an open unit of work (reads then use its connection; nothing is created). */
  inTransaction(): boolean {
    return hasActiveTransaction(this.dataSource);
  }

  /** Retired keys, newest first (to open copies sealed before a rotation). */
  async retired(): Promise<StoredServerKey[]> {
    const rows = await currentManager(this.dataSource)
      .getRepository(CloudServerKeyTypeormEntity)
      .find({ where: { retiredAt: Not(IsNull()) }, order: { id: 'DESC' } });
    return rows.map(toStored);
  }

  /** The current key, or null (read only: never creates). */
  async current(): Promise<StoredServerKey | null> {
    const row = await currentManager(this.dataSource)
      .getRepository(CloudServerKeyTypeormEntity)
      .findOne({ where: { retiredAt: IsNull() } });
    return row ? toStored(row) : null;
  }
}

function toStored(row: CloudServerKeyTypeormEntity): StoredServerKey {
  return {
    publicKey: row.publicKey,
    encryptedPrivateKey: row.encryptedPrivateKey,
    kmsKeyArn: row.kmsKeyArn,
  };
}
