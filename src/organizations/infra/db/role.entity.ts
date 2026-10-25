import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { SyncableTypeormEntity } from '../../../shared/infra/db/base.entity.js';
import type { PermissionScope } from '../../domain/rbac-catalog.js';

// organization_id nulo = papel de fábrica (key fixa e única); preenchido = papel próprio da organização.
// A FK para organizations entra junto com essa tabela.
@Entity('roles')
@Check(
  'ck_roles_scope_type',
  `"scope_type" IN ('organization', 'space', 'hub')`,
)
@Index('ix_roles_sync_version', ['syncVersion'])
@Index('uq_roles_factory_key', ['key'], {
  unique: true,
  where: '"organization_id" IS NULL',
})
@Index('uq_roles_organization_key', ['organizationId', 'key'], {
  unique: true,
  where: '"organization_id" IS NOT NULL',
})
@Index('fk_roles_copied_from_idx', ['copiedFromRoleId'])
export class RoleTypeormEntity extends SyncableTypeormEntity {
  @Column({ type: 'uuid', nullable: true })
  organizationId!: string | null;

  @Column({ type: 'varchar', length: 20 })
  scopeType!: PermissionScope;

  @Column({ type: 'varchar', length: 50, nullable: true })
  key!: string | null;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description!: string | null;

  @Column({ type: 'uuid', nullable: true })
  copiedFromRoleId!: string | null;

  @ManyToOne(() => RoleTypeormEntity)
  @JoinColumn({
    name: 'copied_from_role_id',
    foreignKeyConstraintName: 'fk_roles_copied_from',
  })
  copiedFrom?: RoleTypeormEntity;

  @Column({ type: 'timestamptz', nullable: true })
  permissionsReviewedAt!: Date | null;
}
