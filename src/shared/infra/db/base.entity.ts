import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

export abstract class BaseTypeormEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', nullable: true })
  updatedAt!: Date | null;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}

// Tabelas que o hub/app sincronizam. sync_version é preenchido por trigger (sequência global).
// bigint volta como string no driver pg.
export abstract class SyncableTypeormEntity extends BaseTypeormEntity {
  @Column({ type: 'bigint', insert: false, update: false })
  syncVersion!: string;
}
