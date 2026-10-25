import { Column, Entity, Index } from 'typeorm';
import { SyncableTypeormEntity } from '../../../shared/infra/db/base.entity.js';
import type { KdfParams } from '../../domain/kdf-params.js';

@Entity('users')
@Index('uq_users_email', ['email'], {
  unique: true,
  where: '"deleted_at" IS NULL',
})
@Index('ix_users_sync_version', ['syncVersion'])
export class UserTypeormEntity extends SyncableTypeormEntity {
  @Column({ type: 'varchar', length: 255 })
  name!: string;

  // O índice único parcial uq_users_email (WHERE deleted_at IS NULL) é criado na migration.
  @Column({ type: 'varchar', length: 255 })
  email!: string;

  @Column({ type: 'varchar', length: 255 })
  authHash!: string;

  @Column({ type: 'varchar', length: 64 })
  kdfSalt!: string;

  @Column({ type: 'jsonb' })
  kdfParams!: KdfParams;

  @Column({ type: 'text' })
  publicKey!: string;

  @Column({ type: 'text' })
  encryptedPrivateKey!: string;
}
