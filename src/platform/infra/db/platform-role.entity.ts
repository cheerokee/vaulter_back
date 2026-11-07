import { Column, Entity, Index } from 'typeorm';
import { BaseTypeormEntity } from '../../../shared/infra/db/base.entity.js';

// Papéis da equipe (catálogo fixo, semeado pela migration CreatePlatformRoles). Só do backend: sem RLS, sem
// sync_version e fora da sincronização do Hub. O runtime só lê (GRANT SELECT).
@Entity('platform_roles')
@Index('uq_platform_roles_key', ['key'], {
  unique: true,
  where: '"deleted_at" IS NULL',
})
export class PlatformRoleTypeormEntity extends BaseTypeormEntity {
  @Column({ type: 'varchar', length: 50 })
  key!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;
}
