import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { UserTypeormEntity } from './user.entity.js';
import { BaseTypeormEntity } from '../../../shared/infra/db/base.entity.js';
import type {
  DevicePlatform,
  SessionRevokedReason,
} from '../../domain/session.js';

@Entity('user_sessions')
@Check(
  'ck_user_sessions_device_platform',
  `"device_platform" IN ('android', 'ios', 'hub', 'web', 'other')`,
)
@Check(
  'ck_user_sessions_revoked_reason',
  `"revoked_reason" IS NULL OR "revoked_reason" IN ('logout', 'revoked', 'refresh_reuse', 'password_change', 'account_recovery', 'hub_access_lost')`,
)
// Sessão aberta pelo Hub (`POST /hub/user-sessions`) fica presa a ele, e só ela: plataforma `hub` <=> `hub_id`.
@Check(
  'ck_user_sessions_hub_bound',
  `("device_platform" = 'hub') = ("hub_id" IS NOT NULL)`,
)
@Index('ix_user_sessions_user', ['userId', 'revokedAt'])
// Revogação por Hub: só as sessões vivas presas a ele.
@Index('ix_user_sessions_hub', ['hubId', 'userId'], {
  where: '"hub_id" IS NOT NULL AND "revoked_at" IS NULL',
})
export class UserSessionTypeormEntity extends BaseTypeormEntity {
  @Column({ type: 'uuid' })
  userId!: string;

  // Só descreve a FK para o TypeORM (migration:generate); o domínio usa apenas userId.
  @ManyToOne(() => UserTypeormEntity)
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'fk_user_sessions_users',
  })
  user?: UserTypeormEntity;

  @Column({ type: 'varchar', length: 100 })
  deviceName!: string;

  @Column({ type: 'varchar', length: 20, default: 'other' })
  devicePlatform!: DevicePlatform;

  @Column({ type: 'uuid', nullable: true })
  hubId!: string | null;

  // Só descreve a FK (por nome: o identity não importa o módulo hubs); o domínio usa apenas hubId.
  @ManyToOne('HubTypeormEntity')
  @JoinColumn({
    name: 'hub_id',
    foreignKeyConstraintName: 'fk_user_sessions_hubs',
  })
  hub?: { id: string };

  @Column({ type: 'varchar', length: 128 })
  refreshTokenHash!: string;

  @Column({ type: 'timestamptz' })
  refreshExpiresAt!: Date;

  @Column({ type: 'timestamptz' })
  lastUsedAt!: Date;

  @Column({ type: 'varchar', length: 45, nullable: true })
  lastIp!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  revokedReason!: SessionRevokedReason | null;
}
