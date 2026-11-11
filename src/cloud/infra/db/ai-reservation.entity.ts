import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseTypeormEntity } from '../../../shared/infra/db/base.entity.js';
import type { AiUsageKind } from '../../domain/ai-usage.js';

// Livro de uso da IA, parte 1 (spec active-cloud §4.4): cada chamada que custa (lote de embeddings da indexação,
// resposta) reserva antes o custo estimado sob a trava da organização e depois acerta o real (`settled`) ou devolve
// (`released`). Uma reserva esquecida (o processo caiu no meio) para de contar em `expires_at` e vira `expired` na
// próxima reserva; um acerto tardio ainda grava o gasto real. SÓ ids, tipo, modelo, tokens e custos: nada legível.
// Append-only na prática (o runtime só tem SELECT/INSERT/UPDATE). RLS por organização. Não sincroniza.
@Entity('cloud_ai_reservations')
@Index('ix_cloud_ai_reservations_live', ['organizationId', 'month'], {
  where: `"status" = 'reserved'`,
})
@Index('fk_cloud_ai_reservations_spaces_idx', ['spaceId', 'organizationId'])
@Index('fk_cloud_ai_reservations_organizations_idx', ['organizationId'])
@Check('ck_cloud_ai_reservations_kind', `"kind" IN ('answer', 'indexing')`)
@Check(
  'ck_cloud_ai_reservations_status',
  `"status" IN ('reserved', 'settled', 'released', 'expired')`,
)
@Check('ck_cloud_ai_reservations_amount', `"amount_micro_usd" >= 0`)
@Check(
  'ck_cloud_ai_reservations_settled',
  `("status" = 'settled') = ("settled_at" IS NOT NULL) AND ("settled_at" IS NULL) = ("cost_micro_usd" IS NULL) AND ("settled_at" IS NULL) = ("model" IS NULL) AND ("settled_at" IS NULL) = ("input_tokens" IS NULL) AND ("settled_at" IS NULL) = ("output_tokens" IS NULL)`,
)
@Check(
  'ck_cloud_ai_reservations_spend',
  `"cost_micro_usd" >= 0 AND "input_tokens" >= 0 AND "output_tokens" >= 0`,
)
export class AiReservationTypeormEntity extends BaseTypeormEntity {
  @Column({ type: 'uuid' })
  organizationId!: string;

  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_cloud_ai_reservations_organizations',
  })
  organization?: { id: string };

  @Column({ type: 'uuid' })
  spaceId!: string;

  // FK composta (filho_id, organization_id): a checagem de FK ignora o RLS.
  @ManyToOne('SpaceTypeormEntity')
  @JoinColumn([
    {
      name: 'space_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_cloud_ai_reservations_spaces',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_cloud_ai_reservations_spaces',
    },
  ])
  space?: { id: string };

  @Column({ type: 'varchar', length: 20 })
  kind!: AiUsageKind;

  /** First day of the UTC month the reservation (and its spend) counts in. */
  @Column({ type: 'date' })
  month!: string;

  @Column({ type: 'bigint' })
  amountMicroUsd!: string;

  @Column({ type: 'varchar', length: 20, default: 'reserved' })
  status!: 'reserved' | 'settled' | 'released' | 'expired';

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  settledAt!: Date | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  model!: string | null;

  @Column({ type: 'bigint', nullable: true })
  inputTokens!: string | null;

  @Column({ type: 'bigint', nullable: true })
  outputTokens!: string | null;

  @Column({ type: 'bigint', nullable: true })
  costMicroUsd!: string | null;
}
