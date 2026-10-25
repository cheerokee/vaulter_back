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
  `"revoked_reason" IS NULL OR "revoked_reason" IN ('logout', 'revoked', 'refresh_reuse', 'password_change')`,
)
@Index('ix_user_sessions_user', ['userId', 'revokedAt'])
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
