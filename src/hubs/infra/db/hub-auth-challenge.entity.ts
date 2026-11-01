import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseTypeormEntity } from '../../../shared/infra/db/base.entity.js';
import { HubTypeormEntity } from './hub.entity.js';

// Desafio de autenticação do Hub (só o hash). hub_id nulo = desafio falso (Hub inexistente; nunca valida).
// Só do backend: sem RLS e sem sync_version. Uso único.
@Entity('hub_auth_challenges')
@Index('uq_hub_auth_challenges_hash', ['challengeHash'], { unique: true })
@Index('fk_hub_auth_challenges_hubs_idx', ['hubId'])
export class HubAuthChallengeTypeormEntity extends BaseTypeormEntity {
  @Column({ type: 'uuid', nullable: true })
  hubId!: string | null;

  @ManyToOne(() => HubTypeormEntity)
  @JoinColumn({
    name: 'hub_id',
    foreignKeyConstraintName: 'fk_hub_auth_challenges_hubs',
  })
  hub?: HubTypeormEntity;

  @Column({ type: 'varchar', length: 64 })
  challengeHash!: string;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  usedAt!: Date | null;
}
