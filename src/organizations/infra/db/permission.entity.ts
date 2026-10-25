import { Check, Column, Entity, Index } from 'typeorm';
import { SyncableTypeormEntity } from '../../../shared/infra/db/base.entity.js';
import type { PermissionScope } from '../../domain/rbac-catalog.js';

@Entity('permissions')
@Check(
  'ck_permissions_scope_type',
  `"scope_type" IN ('organization', 'space', 'hub')`,
)
@Index('ix_permissions_sync_version', ['syncVersion'])
@Index('uq_permissions_key', ['key'], { unique: true })
export class PermissionTypeormEntity extends SyncableTypeormEntity {
  @Column({ type: 'varchar', length: 100 })
  key!: string;

  @Column({ type: 'varchar', length: 20 })
  scopeType!: PermissionScope;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description!: string | null;
}
