import {
  Check,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { ConversationAttachmentTypeormEntity } from './conversation-attachment.entity.js';

// A parte dos anexos no uso de um espaço (spec conversations §4.4): uma projeção por anexo, mantida SÓ pelo trigger
// `trg_conversation_attachments_space_usage` (migration ConversationAttachmentStorage), com RLS só da organização. Existe
// pelo mesmo motivo do contador das mensagens: os anexos só são visíveis a quem participa, e o uso do espaço é lido por
// quem não participa (Gestor, backup). Uma linha por anexo (e não um contador) porque a reserva da intenção vence no
// tempo (`reserved_until`), como no backup. `stored` = confirmado (conta até `purged`), `trash` = confirmado com lápide.
// Não sincroniza.
@Entity('conversation_attachment_usage')
@Check('ck_conversation_attachment_usage_size_bytes', `"size_bytes" > 0`)
@Check('ck_conversation_attachment_usage_trash', `NOT "trash" OR "stored"`)
@Check(
  'ck_conversation_attachment_usage_reserved',
  `NOT ("stored" AND "reserved_until" IS NOT NULL)`,
)
@Index('ix_conversation_attachment_usage_space', ['organizationId', 'spaceId'])
export class ConversationAttachmentUsageTypeormEntity {
  @PrimaryColumn('uuid')
  attachmentId!: string;

  @ManyToOne('ConversationAttachmentTypeormEntity')
  @JoinColumn({
    name: 'attachment_id',
    foreignKeyConstraintName: 'fk_conversation_attachment_usage_attachments',
  })
  attachment?: ConversationAttachmentTypeormEntity;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', nullable: true })
  updatedAt!: Date | null;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @Column({ type: 'uuid' })
  organizationId!: string;

  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_conversation_attachment_usage_organizations',
  })
  organization?: { id: string };

  @Column({ type: 'uuid' })
  spaceId!: string;

  // Alvo por nome: um módulo não importa a infra/ do outro.
  @ManyToOne('SpaceTypeormEntity')
  @JoinColumn([
    {
      name: 'space_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_conversation_attachment_usage_spaces',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_conversation_attachment_usage_spaces',
    },
  ])
  space?: { id: string };

  @Column({ type: 'bigint' })
  sizeBytes!: string;

  @Column({ type: 'boolean', default: false })
  stored!: boolean;

  @Column({ type: 'boolean', default: false })
  trash!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  reservedUntil!: Date | null;
}
