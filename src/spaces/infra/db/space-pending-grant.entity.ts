import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseTypeormEntity } from '../../../shared/infra/db/base.entity.js';
import type { PendingGrantStatus } from '../../domain/pending-grant.repository.js';
import { SpaceTypeormEntity } from './space.entity.js';

// Pendência de trancar a chave para quem foi indicado por convite. Só do backend (sem sync_version), nunca
// carrega material de chave. RLS por organization_id. Uma pendência aberta por pessoa em cada espaço.
@Entity('space_pending_grants')
@Check(
  'ck_space_pending_grants_status',
  `"status" IN ('pending', 'granted', 'declined', 'cancelled')`,
)
@Index('uq_space_pending_grants_open', ['spaceId', 'userId'], {
  unique: true,
  where: `"status" = 'pending' AND "deleted_at" IS NULL`,
})
@Index('fk_space_pending_grants_organizations_idx', ['organizationId'])
@Index('fk_space_pending_grants_spaces_idx', ['spaceId'])
@Index('fk_space_pending_grants_users_idx', ['userId'])
@Index('fk_space_pending_grants_roles_idx', ['roleId'])
@Index('fk_space_pending_grants_invitations_idx', ['invitationId'])
@Index('fk_space_pending_grants_requested_by_idx', ['requestedByUserId'])
export class SpacePendingGrantTypeormEntity extends BaseTypeormEntity {
  @Column({ type: 'uuid' })
  organizationId!: string;

  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_space_pending_grants_organizations',
  })
  organization?: { id: string };

  @Column({ type: 'uuid' })
  spaceId!: string;

  @ManyToOne(() => SpaceTypeormEntity)
  @JoinColumn([
    {
      name: 'space_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_space_pending_grants_spaces',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_space_pending_grants_spaces',
    },
  ])
  space?: SpaceTypeormEntity;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'fk_space_pending_grants_users',
  })
  user?: { id: string };

  @Column({ type: 'uuid' })
  roleId!: string;

  @ManyToOne('RoleTypeormEntity')
  @JoinColumn({
    name: 'role_id',
    foreignKeyConstraintName: 'fk_space_pending_grants_roles',
  })
  role?: { id: string };

  @Column({ type: 'uuid', nullable: true })
  invitationId!: string | null;

  @ManyToOne('OrganizationInvitationTypeormEntity')
  @JoinColumn([
    {
      name: 'invitation_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_space_pending_grants_invitations',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_space_pending_grants_invitations',
    },
  ])
  invitation?: { id: string };

  @Column({ type: 'uuid', nullable: true })
  requestedByUserId!: string | null;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'requested_by_user_id',
    foreignKeyConstraintName: 'fk_space_pending_grants_requested_by',
  })
  requestedBy?: { id: string };

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: PendingGrantStatus;
}
