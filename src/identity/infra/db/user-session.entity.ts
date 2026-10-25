import { Column, Entity, Index } from 'typeorm';
import { BaseTypeormEntity } from '../../../shared/infra/db/base.entity.js';
import type {
  DevicePlatform,
  SessionRevokedReason,
} from '../../domain/session.js';

@Entity('user_sessions')
@Index('ix_user_sessions_user', ['userId', 'revokedAt'])
export class UserSessionTypeormEntity extends BaseTypeormEntity {
  @Column({ type: 'uuid' })
  userId!: string;

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
