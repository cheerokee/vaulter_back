import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

// Base das tabelas sincronizáveis cujo id vem do aparelho (conversa, mensagem, anexo: o id entra no AD da cifra), sem
// default no banco. sync_version é preenchido por trigger (bigint volta como string no driver pg).
export abstract class DeviceIdSyncableTypeormEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', nullable: true })
  updatedAt!: Date | null;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @Column({ type: 'bigint', insert: false, update: false })
  syncVersion!: string;
}
