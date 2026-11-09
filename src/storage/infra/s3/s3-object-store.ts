import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  ObjectStore,
  type ObjectHead,
  type PresignedPut,
  type PresignPutInput,
} from '../../application/ports/object-store.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Tag set by the presigned PUT. S3 lifecycle filters only match a key *prefix*, and the provisional uploads live in
 * the middle of the path (`orgs/<orgId>/spaces/<spaceId>/uploads/<uploadId>`), so the 1-day rule matches this tag
 * instead (see `.docker/localstack/init/ready.d/01-buckets.sh`). `copy` replaces the tags, so final objects never
 * carry it.
 */
export const UPLOAD_TAGGING = 'stage=upload';

// Kept as headers (not hoisted to the query string) so they are signed and sent by the client: S3 checks the body
// against the checksum header, and the tag header is what the object gets.
const UNHOISTABLE = new Set(['x-amz-checksum-sha256', 'x-amz-tagging']);

@Injectable()
export class S3ObjectStore extends ObjectStore implements OnModuleDestroy {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigService) {
    super();
    this.bucket = config.getOrThrow<string>('S3_BUCKET_HUB_BRAIN');
    const accessKeyId = config.get<string>('AWS_ACCESS_KEY_ID');
    const secretAccessKey = config.get<string>('AWS_SECRET_ACCESS_KEY');
    this.client = new S3Client({
      region: config.getOrThrow<string>('AWS_REGION'),
      endpoint: config.get<string>('AWS_ENDPOINT_URL') || undefined,
      forcePathStyle: config.get<boolean>('S3_FORCE_PATH_STYLE') === true,
      // Without static keys the SDK's default chain applies (IAM role in production).
      credentials:
        accessKeyId && secretAccessKey
          ? { accessKeyId, secretAccessKey }
          : undefined,
      // Only the checksums we set explicitly: otherwise the SDK adds a CRC32 of the (empty) presign body.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  async presignPut(
    key: string,
    { sizeBytes, sha256Hex, expiresInSeconds }: PresignPutInput,
  ): Promise<PresignedPut> {
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw new Error('presignPut: sizeBytes must be a non-negative integer');
    }
    if (!SHA256_HEX.test(sha256Hex)) {
      throw new Error('presignPut: sha256Hex must be 64 lowercase hex chars');
    }
    const checksum = Buffer.from(sha256Hex, 'hex').toString('base64');
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentLength: sizeBytes,
        ChecksumSHA256: checksum,
        Tagging: UPLOAD_TAGGING,
      }),
      { expiresIn: expiresInSeconds, unhoistableHeaders: new Set(UNHOISTABLE) },
    );
    return {
      url,
      headers: {
        'content-length': String(sizeBytes),
        'x-amz-checksum-sha256': checksum,
        'x-amz-tagging': UPLOAD_TAGGING,
      },
    };
  }

  presignGet(
    key: string,
    versionId: string,
    expiresInSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        VersionId: versionId,
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const out = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ChecksumMode: 'ENABLED',
        }),
      );
      return {
        sizeBytes: out.ContentLength ?? 0,
        sha256Hex: sha256FromChecksum(out.ChecksumSHA256),
        versionId: out.VersionId ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async copy(fromKey: string, toKey: string): Promise<{ versionId: string }> {
    const out = await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: toKey,
        CopySource: `${this.bucket}/${encodeKey(fromKey)}`,
        ChecksumAlgorithm: 'SHA256',
        // The source is a provisional upload: without REPLACE its stage=upload tag would expire the copy in 1 day.
        TaggingDirective: 'REPLACE',
        Tagging: '',
      }),
    );
    if (!out.VersionId) {
      throw new Error(
        `copy: no VersionId returned (is versioning enabled on ${this.bucket}?)`,
      );
    }
    return { versionId: out.VersionId };
  }

  async deleteCurrent(key: string): Promise<{ deleteMarkerVersionId: string }> {
    const out = await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!out.DeleteMarker || !out.VersionId) {
      throw new Error(
        `deleteCurrent: no delete marker created (is versioning enabled on ${this.bucket}?)`,
      );
    }
    return { deleteMarkerVersionId: out.VersionId };
  }

  async deleteVersion(key: string, versionId: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
        VersionId: versionId,
      }),
    );
  }
}

function sha256FromChecksum(checksum: string | undefined): string | null {
  // A multipart upload reports a composite checksum (`<base64>-<parts>`), which is not the sha256 of the object.
  if (!checksum || checksum.includes('-')) return null;
  const bytes = Buffer.from(checksum, 'base64');
  return bytes.length === 32 ? bytes.toString('hex') : null;
}

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof S3ServiceException &&
    (error.name === 'NotFound' ||
      error.name === 'NoSuchKey' ||
      error.$metadata.httpStatusCode === 404)
  );
}
