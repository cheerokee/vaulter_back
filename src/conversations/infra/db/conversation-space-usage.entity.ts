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

// A parte dos assuntos no uso de um espaço (spec conversations §4.4.1): um contador por espaço, mantido SÓ pelo trigger
// `trg_conversation_messages_space_usage` (migration ConversationSpaceUsage). `body_bytes` = corpos cifrados ainda
// guardados (vivos e na lixeira de 30 dias; o corpo zerado pela retenção sai), `trash_bytes` = a parte com lápide. O
// contador existe porque as mensagens só são visíveis a quem participa (RLS): somá-las no contexto de quem lê o uso
// (Gestor, intenção de envio do backup) contaria só os assuntos dele. RLS só por organização; não sincroniza.
@Entity('conversation_space_usage')
@Check('ck_conversation_space_usage_body_bytes', `"body_bytes" >= 0`)
@Check(
  'ck_conversation_space_usage_trash_bytes',
  `"trash_bytes" >= 0 AND "trash_bytes" <= "body_bytes"`,
)
@Index('fk_conversation_space_usage_organizations_idx', ['organizationId'])
export class ConversationSpaceUsageTypeormEntity {
  @PrimaryColumn('uuid')
  spaceId!: string;

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
    foreignKeyConstraintName: 'fk_conversation_space_usage_organizations',
  })
  organization?: { id: string };

  // Alvo por nome: um módulo não importa a infra/ do outro.
  @ManyToOne('SpaceTypeormEntity')
  @JoinColumn([
    {
      name: 'space_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_conversation_space_usage_spaces',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_conversation_space_usage_spaces',
    },
  ])
  space?: { id: string };

  @Column({ type: 'bigint', default: 0 })
  bodyBytes!: string;

  @Column({ type: 'bigint', default: 0 })
  trashBytes!: string;
}
