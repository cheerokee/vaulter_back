import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  Unique,
} from 'typeorm';
import { BaseTypeormEntity } from '../../../shared/infra/db/base.entity.js';
import type { InvitationStatus } from '../../domain/invitation.js';
import { OrganizationTypeormEntity } from './organization.entity.js';
import { RoleTypeormEntity } from './role.entity.js';

// Só do backend (não sincroniza: sem sync_version). Guarda só o hash do token. RLS por organization_id; a
// busca por token antes de haver organização usa a policy invitation_by_token (`app.invitation_token_hash`).
@Entity('organization_invitations')
// Alvo das FKs compostas (filho_id, organization_id): o pai precisa ser da mesma organização.
@Unique('uq_organization_invitations_id_organization', ['id', 'organizationId'])
@Check(
  'ck_organization_invitations_status',
  `"status" IN ('pending', 'accepted', 'revoked', 'expired')`,
)
@Index('uq_organization_invitations_token_hash', ['tokenHash'], {
  unique: true,
})
@Index('fk_organization_invitations_organizations_idx', ['organizationId'])
@Index('fk_organization_invitations_roles_idx', ['roleId'])
@Index('fk_organization_invitations_created_by_idx', ['createdByUserId'])
@Index('fk_organization_invitations_accepted_by_idx', ['acceptedByUserId'])
export class OrganizationInvitationTypeormEntity extends BaseTypeormEntity {
  @Column({ type: 'uuid' })
  organizationId!: string;

  @ManyToOne(() => OrganizationTypeormEntity)
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_organization_invitations_organizations',
  })
  organization?: OrganizationTypeormEntity;

  @Column({ type: 'varchar', length: 128 })
  tokenHash!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email!: string | null;

  @Column({ type: 'uuid' })
  roleId!: string;

  @ManyToOne(() => RoleTypeormEntity)
  @JoinColumn({
    name: 'role_id',
    foreignKeyConstraintName: 'fk_organization_invitations_roles',
  })
  role?: RoleTypeormEntity;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: InvitationStatus;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'uuid' })
  createdByUserId!: string;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'created_by_user_id',
    foreignKeyConstraintName: 'fk_organization_invitations_created_by',
  })
  createdBy?: { id: string };

  @Column({ type: 'uuid', nullable: true })
  acceptedByUserId!: string | null;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'accepted_by_user_id',
    foreignKeyConstraintName: 'fk_organization_invitations_accepted_by',
  })
  acceptedBy?: { id: string };

  @Column({ type: 'timestamptz', nullable: true })
  acceptedAt!: Date | null;
}
