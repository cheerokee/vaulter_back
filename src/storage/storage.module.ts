import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HubsModule } from '../hubs/hubs.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { SpacesModule } from '../spaces/spaces.module.js';
import { BackupContentReader } from './application/backup-content-reader.js';
import { BackupObjectHealer } from './application/backup-object-healer.js';
import { BackupTrash } from './application/backup-trash.js';
import { ConfirmUploadsUseCase } from './application/confirm-uploads.use-case.js';
import { DeleteObjectsUseCase } from './application/delete-objects.use-case.js';
import { EmptyTrashUseCase } from './application/empty-trash.use-case.js';
import { GetDownloadUrlUseCase } from './application/get-download-url.use-case.js';
import { ListObjectsUseCase } from './application/list-objects.use-case.js';
import { BackupIndexReader } from './application/ports/backup-index-reader.js';
import { ObjectStore } from './application/ports/object-store.js';
import { ReconcileStorageUseCase } from './application/reconcile-storage.use-case.js';
import { RequestUploadsUseCase } from './application/request-uploads.use-case.js';
import { BackupSpaceStorageUsage } from './application/space-storage-usage.js';
import { StorageAccess } from './application/storage-access.js';
import { BackupObjectRepository } from './domain/backup-object.repository.js';
import { BackupObjectVersionRepository } from './domain/backup-object-version.repository.js';
import { BackupIndexSqlReader } from './infra/db/backup-index.sql-reader.js';
import { BackupObjectTypeormRepository } from './infra/db/backup-object.typeorm-repository.js';
import { BackupObjectVersionTypeormRepository } from './infra/db/backup-object-version.typeorm-repository.js';
import { StorageObjectVersionTypeormEntity } from './infra/db/storage-object-version.entity.js';
import { StorageObjectTypeormEntity } from './infra/db/storage-object.entity.js';
import { HubBackupController } from './infra/http/hub-backup.controller.js';
import { SpaceBackupController } from './infra/http/space-backup.controller.js';
import { S3ObjectStore } from './infra/s3/s3-object-store.js';

/**
 * Encrypted backup of spaces (spec 2026-11-09-storage-backup). Depends on `spaces` (SpaceContentAccess, the usage
 * port it binds), `hubs` (HubDirectory), `identity` (CurrentAuthProofVerifier: emptying the trash reauthenticates) and
 * `organizations` (AuditLog) through what they export. Exports the `ObjectStore` port (the bucket), for another
 * index of the same bucket (`conversations`: attachments) that reuses the mechanism through `application/object-uploads`,
 * and `BackupContentReader` (the server's own read of the encrypted backup by the index's versions: active cloud).
 * Emits `BackupObjectsChangedHooks` on confirm/delete (the active cloud enqueues its reindexing there).
 */
@Module({
  imports: [
    IdentityModule,
    OrganizationsModule,
    SpacesModule,
    HubsModule,
    TypeOrmModule.forFeature([
      StorageObjectTypeormEntity,
      StorageObjectVersionTypeormEntity,
    ]),
  ],
  controllers: [HubBackupController, SpaceBackupController],
  providers: [
    { provide: ObjectStore, useClass: S3ObjectStore },
    {
      provide: BackupObjectRepository,
      useClass: BackupObjectTypeormRepository,
    },
    {
      provide: BackupObjectVersionRepository,
      useClass: BackupObjectVersionTypeormRepository,
    },
    { provide: BackupIndexReader, useClass: BackupIndexSqlReader },
    StorageAccess,
    BackupContentReader,
    BackupSpaceStorageUsage,
    BackupObjectHealer,
    BackupTrash,
    ReconcileStorageUseCase,
    RequestUploadsUseCase,
    ConfirmUploadsUseCase,
    DeleteObjectsUseCase,
    EmptyTrashUseCase,
    ListObjectsUseCase,
    GetDownloadUrlUseCase,
  ],
  exports: [ObjectStore, BackupContentReader],
})
export class StorageModule {}
