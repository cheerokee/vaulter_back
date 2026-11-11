import { Check, Column, Entity, Index } from 'typeorm';
import { BaseTypeormEntity } from '../../../shared/infra/db/base.entity.js';

// Par X25519 do servidor (módulo cloud): a pública em claro e a privada só cifrada pelo KMS (envelope; o contexto de
// cifra amarra a cópia à pública da linha). Dado do servidor, não de cliente: sem organization_id nem RLS, e nunca
// sincronizado. Atual = `retired_at` nulo (uma só, garantida pela trava de geração em ServerKeyTypeormStore); as
// aposentadas ficam para abrir cópias seladas antes de uma rotação. Runtime: SELECT/INSERT e UPDATE só de
// `retired_at`/`updated_at` (migration CreateCloudServerKeys): a chave gravada é imutável.
@Entity('cloud_server_keys')
@Index('uq_cloud_server_keys_public_key', ['publicKey'], { unique: true })
@Check('chk_cloud_server_keys_public_key', `char_length("public_key") = 43`)
export class CloudServerKeyTypeormEntity extends BaseTypeormEntity {
  @Column({ type: 'varchar', length: 43 })
  publicKey!: string;

  /** KMS `CiphertextBlob` of the 32-byte private key, base64. */
  @Column({ type: 'text' })
  encryptedPrivateKey!: string;

  /** ARN of the KMS key that produced the ciphertext (KMS finds it from the blob; kept for audits/rotation). */
  @Column({ type: 'varchar', length: 2048 })
  kmsKeyArn!: string;

  @Column({ type: 'timestamptz', nullable: true })
  retiredAt!: Date | null;
}
