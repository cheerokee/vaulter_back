import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseTypeormEntity } from '../../../shared/infra/db/base.entity.js';
import { SpaceTypeormEntity } from './space.entity.js';

// Espaços indicados num convite, com o papel em cada um. Só do backend (sem sync_version). RLS por
// organization_id. Um espaço aparece uma vez por convite.
@Entity('invitation_space_intents')
@Index(
  'uq_invitation_space_intents_invitation_space',
  ['invitationId', 'spaceId'],
  { unique: true, where: '"deleted_at" IS NULL' },
)
@Index('fk_invitation_space_intents_organizations_idx', ['organizationId'])
@Index('fk_invitation_space_intents_invitations_idx', ['invitationId'])
@Index('fk_invitation_space_intents_spaces_idx', ['spaceId'])
@Index('fk_invitation_space_intents_roles_idx', ['roleId'])
@Index('fk_invitation_space_intents_requested_by_idx', ['requestedByUserId'])
export class InvitationSpaceIntentTypeormEntity extends BaseTypeormEntity {
  @Column({ type: 'uuid' })
  organizationId!: string;

  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_invitation_space_intents_organizations',
  })
  organization?: { id: string };

  @Column({ type: 'uuid' })
  invitationId!: string;

  @ManyToOne('OrganizationInvitationTypeormEntity')
  @JoinColumn([
    {
      name: 'invitation_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_invitation_space_intents_invitations',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_invitation_space_intents_invitations',
    },
  ])
  invitation?: { id: string };

  @Column({ type: 'uuid' })
  spaceId!: string;

  @ManyToOne(() => SpaceTypeormEntity)
  @JoinColumn([
    {
      name: 'space_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_invitation_space_intents_spaces',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_invitation_space_intents_spaces',
    },
  ])
  space?: SpaceTypeormEntity;

  @Column({ type: 'uuid' })
  roleId!: string;

  @ManyToOne('RoleTypeormEntity')
  @JoinColumn({
    name: 'role_id',
    foreignKeyConstraintName: 'fk_invitation_space_intents_roles',
  })
  role?: { id: string };

  // Quem indicou o espaço no convite (Gestor dele); vira o requested_by da pendência no aceite. Nulo só nas
  // linhas gravadas antes da coluna existir.
  @Column({ type: 'uuid', nullable: true })
  requestedByUserId!: string | null;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'requested_by_user_id',
    foreignKeyConstraintName: 'fk_invitation_space_intents_requested_by',
  })
  requestedBy?: { id: string };
}
