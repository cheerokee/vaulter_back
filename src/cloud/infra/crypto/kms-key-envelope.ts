import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';

export interface EnvelopedSecret {
  /** KMS `CiphertextBlob`, base64. */
  ciphertext: string;
  /** ARN of the KMS key that produced it. */
  keyArn: string;
}

/**
 * Envelope of small secrets (≤ 4 KiB) by a KMS symmetric key (`CLOUD_KMS_KEY_ID`, LocalStack in dev). The encryption
 * context is authenticated: a ciphertext only opens with the same context (it binds the private key to its public
 * key). Plaintext never leaves this class except as the returned buffer.
 */
@Injectable()
export class KmsKeyEnvelope implements OnModuleDestroy {
  private readonly client: KMSClient;
  private readonly keyId: string;

  constructor(config: ConfigService) {
    this.keyId = config.getOrThrow<string>('CLOUD_KMS_KEY_ID');
    const accessKeyId = config.get<string>('AWS_ACCESS_KEY_ID');
    const secretAccessKey = config.get<string>('AWS_SECRET_ACCESS_KEY');
    this.client = new KMSClient({
      region: config.getOrThrow<string>('AWS_REGION'),
      endpoint: config.get<string>('AWS_ENDPOINT_URL') || undefined,
      // Without static keys the SDK's default chain applies (IAM role in production).
      credentials:
        accessKeyId && secretAccessKey
          ? { accessKeyId, secretAccessKey }
          : undefined,
    });
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  async seal(
    plaintext: Uint8Array,
    context: Record<string, string>,
  ): Promise<EnvelopedSecret> {
    const out = await this.client.send(
      new EncryptCommand({
        KeyId: this.keyId,
        Plaintext: plaintext,
        EncryptionContext: context,
      }),
    );
    if (!out.CiphertextBlob || !out.KeyId) {
      throw new Error('KMS Encrypt returned no ciphertext');
    }
    return {
      ciphertext: Buffer.from(out.CiphertextBlob).toString('base64'),
      keyArn: out.KeyId,
    };
  }

  async open(
    ciphertext: string,
    context: Record<string, string>,
  ): Promise<Uint8Array> {
    const out = await this.client.send(
      new DecryptCommand({
        CiphertextBlob: Buffer.from(ciphertext, 'base64'),
        EncryptionContext: context,
      }),
    );
    if (!out.Plaintext) throw new Error('KMS Decrypt returned no plaintext');
    return out.Plaintext;
  }
}
