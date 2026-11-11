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
import type { AiUsageKind } from '../../domain/ai-usage.js';

// Livro de uso da IA, parte 2 (spec active-cloud §4.4): o gasto acertado do mês por espaço e tipo (`answer` /
// `indexing`), somado a cada acerto (`cloud_ai_reservations` guarda cada chamada). A soma das linhas do mês é o que a
// organização gastou; os admins a veem em `GET /organizations/:id/ai-usage`. Fica depois de desligar a nuvem (não é
// legível: só ids, contagens e custos). RLS por organização. Não sincroniza.
@Entity('cloud_ai_usage')
@Unique('uq_cloud_ai_usage_month_space_kind', [
  'organizationId',
  'month',
  'spaceId',
  'kind',
])
@Index('fk_cloud_ai_usage_spaces_idx', ['spaceId', 'organizationId'])
@Check('ck_cloud_ai_usage_kind', `"kind" IN ('answer', 'indexing')`)
@Check(
  'ck_cloud_ai_usage_counts',
  `"cost_micro_usd" >= 0 AND "input_tokens" >= 0 AND "output_tokens" >= 0 AND "calls" >= 0`,
)
export class AiUsageTypeormEntity extends BaseTypeormEntity {
  @Column({ type: 'uuid' })
  organizationId!: string;

  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_cloud_ai_usage_organizations',
  })
  organization?: { id: string };

  @Column({ type: 'uuid' })
  spaceId!: string;

  @ManyToOne('SpaceTypeormEntity')
  @JoinColumn([
    {
      name: 'space_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_cloud_ai_usage_spaces',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_cloud_ai_usage_spaces',
    },
  ])
  space?: { id: string };

  @Column({ type: 'varchar', length: 20 })
  kind!: AiUsageKind;

  @Column({ type: 'date' })
  month!: string;

  @Column({ type: 'bigint', default: 0 })
  costMicroUsd!: string;

  @Column({ type: 'bigint', default: 0 })
  inputTokens!: string;

  @Column({ type: 'bigint', default: 0 })
  outputTokens!: string;

  @Column({ type: 'integer', default: 0 })
  calls!: number;
}
