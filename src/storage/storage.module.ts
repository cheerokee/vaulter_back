import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HubsModule } from '../hubs/hubs.module.js';
import { SpacesModule } from '../spaces/spaces.module.js';
import { ConfirmUploadsUseCase } from './application/confirm-uploads.use-case.js';
import { DeleteObjectsUseCase } from './application/delete-objects.use-case.js';
import { ObjectStore } from './application/ports/object-store.js';
import { RequestUploadsUseCase } from './application/request-uploads.use-case.js';
import { BackupSpaceStorageUsage } from './application/space-storage-usage.js';
import { StorageAccess } from './application/storage-access.js';
import { BackupObjectRepository } from './domain/backup-object.repository.js';
import { BackupObjectVersionRepository } from './domain/backup-object-version.repository.js';
import { BackupObjectTypeormRepository } from './infra/db/backup-object.typeorm-repository.js';
import { BackupObjectVersionTypeormRepository } from './infra/db/backup-object-version.typeorm-repository.js';
import { StorageObjectVersionTypeormEntity } from './infra/db/storage-object-version.entity.js';
import { StorageObjectTypeormEntity } from './infra/db/storage-object.entity.js';
import { HubBackupController } from './infra/http/hub-backup.controller.js';
import { SpaceBackupController } from './infra/http/space-backup.controller.js';
import { S3ObjectStore } from './infra/s3/s3-object-store.js';

/**
 * Encrypted backup of spaces (spec 2026-11-09-storage-backup). Depends on `spaces` (SpaceContentAccess, the usage
 * port it binds) and `hubs` (HubDirectory) through what they export. Exports nothing: no module imports `storage`.
 */
@Module({
  imports: [
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
    StorageAccess,
    BackupSpaceStorageUsage,
    RequestUploadsUseCase,
    ConfirmUploadsUseCase,
    DeleteObjectsUseCase,
  ],
})
export class StorageModule {}
