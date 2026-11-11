import { Injectable } from '@nestjs/common';
import { DataSource, IsNull, Not } from 'typeorm';
import {
  currentManager,
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
   * The current key, or the one `generate` produces when there is none (in a transaction holding the generation
   * lock; the check is repeated under it). `generate` runs at most once per database lifetime in normal operation.
   */
  async currentOrCreate(
    generate: () => Promise<StoredServerKey>,
  ): Promise<StoredServerKey> {
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

  /** Retired keys, newest first (to open copies sealed before a rotation). */
  async retired(): Promise<StoredServerKey[]> {
    const rows = await currentManager(this.dataSource)
      .getRepository(CloudServerKeyTypeormEntity)
      .find({ where: { retiredAt: Not(IsNull()) }, order: { id: 'DESC' } });
    return rows.map(toStored);
  }

  private async current(): Promise<StoredServerKey | null> {
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
