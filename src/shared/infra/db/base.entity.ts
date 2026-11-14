import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

export abstract class BaseTypeormEntity {
  @PrimaryColumn('uuid', { default: () => 'uuidv7()' })
  id!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', nullable: true })
  updatedAt!: Date | null;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}

// Tabelas sincronizáveis. sync_version é preenchido por trigger: sequência global no catálogo RBAC; nas tabelas da
// sincronização do Hub, no COMMIT (`CommitOrderedSyncableTypeormEntity`). bigint volta como string no driver pg.
export abstract class SyncableTypeormEntity extends BaseTypeormEntity {
  @Column({ type: 'bigint', insert: false, update: false })
  syncVersion!: string;
}

// Tabelas lidas pelo `GET /hub/sync`: versão dada no COMMIT (migration HubSyncCommitOrder); sync_pending é provisória
// até lá, só o banco grava.
export abstract class CommitOrderedSyncableTypeormEntity extends SyncableTypeormEntity {
  @Column({
    type: 'boolean',
    default: true,
    insert: false,
    update: false,
    select: false,
  })
  syncPending!: boolean;
}
