import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseTypeormEntity } from '../../../shared/infra/db/base.entity.js';
import { HubTypeormEntity } from './hub.entity.js';

// Código de vínculo pedido pelo Hub (só o hash). Só do backend: sem RLS e sem sync_version. Uso único.
@Entity('hub_link_codes')
// Único entre os vigentes (ainda não usados).
@Index('uq_hub_link_codes_code_hash', ['codeHash'], {
  unique: true,
  where: '"used_at" IS NULL',
})
@Index('fk_hub_link_codes_hubs_idx', ['hubId'])
export class HubLinkCodeTypeormEntity extends BaseTypeormEntity {
  @Column({ type: 'uuid' })
  hubId!: string;

  @ManyToOne(() => HubTypeormEntity)
  @JoinColumn({
    name: 'hub_id',
    foreignKeyConstraintName: 'fk_hub_link_codes_hubs',
  })
  hub?: HubTypeormEntity;

  @Column({ type: 'varchar', length: 64 })
  codeHash!: string;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  usedAt!: Date | null;
}
