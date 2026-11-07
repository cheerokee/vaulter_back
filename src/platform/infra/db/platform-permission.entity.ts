import { Column, Entity, Index } from 'typeorm';
import { BaseTypeormEntity } from '../../../shared/infra/db/base.entity.js';

// Permissões da plataforma (catálogo fixo, semeado pela migration CreatePlatformRoles). O runtime só lê.
@Entity('platform_permissions')
@Index('uq_platform_permissions_key', ['key'], { unique: true })
export class PlatformPermissionTypeormEntity extends BaseTypeormEntity {
  @Column({ type: 'varchar', length: 100 })
  key!: string;
}
