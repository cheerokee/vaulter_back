import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HubsModule } from '../hubs/hubs.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { SpacesModule } from '../spaces/spaces.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { ConversationAttachmentHealer } from './application/attachment-healer.js';
import { ConfirmAttachmentUseCase } from './application/confirm-attachment.use-case.js';
import { GetAttachmentDownloadUrlUseCase } from './application/get-attachment-download-url.use-case.js';
import { ReconcileConversationAttachments } from './application/reconcile-conversation-attachments.js';
import { RequestAttachmentUploadUseCase } from './application/request-attachment-upload.use-case.js';
import { AckMessageUseCase } from './application/ack-message.use-case.js';
import { ChangeConversationStateUseCase } from './application/change-conversation-state.use-case.js';
import { ChangeExecutorUseCase } from './application/change-executor.use-case.js';
import { ConversationAccess } from './application/conversation-access.js';
import { ConversationDeparture } from './application/conversation-departure.js';
import { ConversationExecutors } from './application/conversation-executors.js';
import { ConversationViews } from './application/conversation-views.js';
import { ConversationStorageUsage } from './application/conversation-storage-usage.js';
import { CreateConversationUseCase } from './application/create-conversation.use-case.js';
import { DeleteMessageUseCase } from './application/delete-message.use-case.js';
import { ConversationsExecutorLostHook } from './application/executor-lost.hook.js';
import { GetConversationUseCase } from './application/get-conversation.use-case.js';
import { HubCreateConversationUseCase } from './application/hub-create-conversation.use-case.js';
import { LeaveConversationUseCase } from './application/leave-conversation.use-case.js';
import { RotateConversationKeyUseCase } from './application/rotate-conversation-key.use-case.js';
import { SendMessageUseCase } from './application/send-message.use-case.js';
import { ShareConversationUseCase } from './application/share-conversation.use-case.js';
import { ConversationsSpaceMemberLeftHook } from './application/space-member-left.hook.js';
import { ConversationAttachmentRepository } from './domain/conversation-attachment.repository.js';
import { ConversationKeyGrantRepository } from './domain/conversation-key-grant.repository.js';
import { ConversationMessageRepository } from './domain/conversation-message.repository.js';
import { ConversationParticipantRepository } from './domain/conversation-participant.repository.js';
import { ConversationSpaceUsageRepository } from './domain/conversation-space-usage.repository.js';
import { ConversationRepository } from './domain/conversation.repository.js';
import { ConversationAttachmentTypeormEntity } from './infra/db/conversation-attachment.entity.js';
import { ConversationAttachmentUsageTypeormEntity } from './infra/db/conversation-attachment-usage.entity.js';
import { ConversationAttachmentTypeormRepository } from './infra/db/conversation-attachment.typeorm-repository.js';
import { ConversationKeyGrantTypeormEntity } from './infra/db/conversation-key-grant.entity.js';
import { ConversationKeyGrantTypeormRepository } from './infra/db/conversation-key-grant.typeorm-repository.js';
import { ConversationMessageTypeormEntity } from './infra/db/conversation-message.entity.js';
import { ConversationMessageTypeormRepository } from './infra/db/conversation-message.typeorm-repository.js';
import { ConversationParticipantTypeormEntity } from './infra/db/conversation-participant.entity.js';
import { ConversationParticipantTypeormRepository } from './infra/db/conversation-participant.typeorm-repository.js';
import { ConversationSpaceUsageTypeormEntity } from './infra/db/conversation-space-usage.entity.js';
import { ConversationSpaceUsageTypeormRepository } from './infra/db/conversation-space-usage.typeorm-repository.js';
import { ConversationTypeormEntity } from './infra/db/conversation.entity.js';
import { ConversationTypeormRepository } from './infra/db/conversation.typeorm-repository.js';
import { HubConversationsController } from './infra/http/hub-conversations.controller.js';
import { ConversationChangesController } from './infra/http/conversation-changes.controller.js';
import { ConversationChangeSignal } from './application/ports/conversation-change-signal.js';
import { ConversationChangesReader } from './application/ports/conversation-changes-reader.js';
import { LongPollSlots } from './application/long-poll-slots.js';
import { SyncConversationsUseCase } from './application/sync-conversations.use-case.js';
import { ConversationChangesSqlReader } from './infra/db/conversation-changes.sql-reader.js';
import { PgConversationChangeSignal } from './infra/db/pg-conversation-change-signal.js';
import { SpaceConversationsController } from './infra/http/space-conversations.controller.js';

/**
 * Conversations ("assuntos") as space data (spec 2026-11-09-conversations): encrypted with their own key, private to
 * their participants and executor Hub. Depends on `spaces` (SpaceAccess, SpaceStorage, and the SpaceStorageUsage
 * port, where it registers the message and attachment bytes), `hubs` (HubDirectory, HubAccess), `organizations`
 * (AuditLog) and `storage` (the ObjectStore port and the shared upload/repair pieces of `application/object-uploads`)
 * through what they export; reacts to `SpaceMemberLeftHooks` and `HubExecutorLostHooks`, and joins the
 * `storage:reconcile` sweep through `StorageReconcileHooks`.
 * Exports nothing: no module imports `conversations`.
 */
@Module({
  imports: [
    OrganizationsModule,
    SpacesModule,
    HubsModule,
    StorageModule,
    TypeOrmModule.forFeature([
      ConversationTypeormEntity,
      ConversationParticipantTypeormEntity,
      ConversationKeyGrantTypeormEntity,
      ConversationMessageTypeormEntity,
      ConversationAttachmentTypeormEntity,
      ConversationSpaceUsageTypeormEntity,
      ConversationAttachmentUsageTypeormEntity,
    ]),
  ],
  controllers: [
    SpaceConversationsController,
    HubConversationsController,
    ConversationChangesController,
  ],
  providers: [
    {
      provide: ConversationRepository,
      useClass: ConversationTypeormRepository,
    },
    {
      provide: ConversationParticipantRepository,
      useClass: ConversationParticipantTypeormRepository,
    },
    {
      provide: ConversationKeyGrantRepository,
      useClass: ConversationKeyGrantTypeormRepository,
    },
    {
      provide: ConversationMessageRepository,
      useClass: ConversationMessageTypeormRepository,
    },
    {
      provide: ConversationAttachmentRepository,
      useClass: ConversationAttachmentTypeormRepository,
    },
    {
      provide: ConversationSpaceUsageRepository,
      useClass: ConversationSpaceUsageTypeormRepository,
    },
    {
      provide: ConversationChangesReader,
      useClass: ConversationChangesSqlReader,
    },
    PgConversationChangeSignal,
    {
      provide: ConversationChangeSignal,
      useExisting: PgConversationChangeSignal,
    },
    LongPollSlots,
    SyncConversationsUseCase,
    ConversationAccess,
    ConversationViews,
    ConversationStorageUsage,
    ConversationExecutors,
    ConversationDeparture,
    ConversationsExecutorLostHook,
    ConversationsSpaceMemberLeftHook,
    CreateConversationUseCase,
    HubCreateConversationUseCase,
    GetConversationUseCase,
    ShareConversationUseCase,
    LeaveConversationUseCase,
    ChangeConversationStateUseCase,
    ChangeExecutorUseCase,
    RotateConversationKeyUseCase,
    SendMessageUseCase,
    AckMessageUseCase,
    DeleteMessageUseCase,
    ConversationAttachmentHealer,
    ReconcileConversationAttachments,
    RequestAttachmentUploadUseCase,
    ConfirmAttachmentUseCase,
    GetAttachmentDownloadUrlUseCase,
  ],
})
export class ConversationsModule {}
