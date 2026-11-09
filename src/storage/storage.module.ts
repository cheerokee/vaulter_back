import { Module } from '@nestjs/common';
import { ObjectStore } from './application/ports/object-store.js';
import { S3ObjectStore } from './infra/s3/s3-object-store.js';

/** Encrypted backup of spaces (spec 2026-11-09-storage-backup). Exports nothing: no module imports `storage`. */
@Module({
  providers: [{ provide: ObjectStore, useClass: S3ObjectStore }],
})
export class StorageModule {}
