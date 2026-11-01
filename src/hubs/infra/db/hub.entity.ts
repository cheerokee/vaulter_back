import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';
import { SyncableTypeormEntity } from '../../../shared/infra/db/base.entity.js';

// Sincronizável e sem organization_id (o Hub não é de organização). RLS (migration CreateHubs): dono, o próprio
// Hub (`app.hub_id`), membro ativo de organização com vínculo aprovado, ou a busca por chave
// (`app.hub_signing_public_key`); INSERT pelo dono; UPDATE pelo dono ou pelo próprio Hub.
@Entity('hubs')
// Alvo da FK composta de hub_organization (hub_id, hub_owner_user_id): o dono desnormalizado é sempre o real.
@Unique('uq_hubs_id_owner', ['id', 'ownerUserId'])
// Única para sempre, inclusive entre Hubs desregistrados (sem WHERE deleted_at).
@Index('uq_hubs_signing_public_key', ['signingPublicKey'], { unique: true })
@Index('fk_hubs_users_idx', ['ownerUserId'])
@Index('ix_hubs_sync_version', ['syncVersion'])
export class HubTypeormEntity extends SyncableTypeormEntity {
  @Column({ type: 'uuid' })
  ownerUserId!: string;

  // Alvo por nome: um módulo não importa a infra/ do outro.
  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'owner_user_id',
    foreignKeyConstraintName: 'fk_hubs_users',
  })
  owner?: { id: string };

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'text' })
  encryptionPublicKey!: string;

  @Column({ type: 'varchar', length: 64 })
  signingPublicKey!: string;

  @Column({ type: 'timestamptz', nullable: true })
  lastSeenAt!: Date | null;
}
