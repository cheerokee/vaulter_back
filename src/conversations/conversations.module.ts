import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HubsModule } from '../hubs/hubs.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { SpacesModule } from '../spaces/spaces.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { ConversationAttachmentHealer } from './application/attachment-healer.js';
import { ConfirmAttachmentUseCase } from './application/confirm-attachment.use-case.js';
import { GetAttachmentDownloadUrlUseCase } from './application/get-attachment-download-url.use-case.js';
import { ReconcileConversationAttachments } from './application/reconcile-conversation-attachments.js';
import { RequestAttachmentUploadUseCase } from './application/request-attachment-upload.use-case.js';
import { AckMessageUseCase } from './application/ack-message.use-case.js';
import { AgentLeaseSweepJob } from './application/agent-lease-sweep.job.js';
import { ConversationRetention } from './application/conversation-retention.js';
import { ConversationUsageReconcile } from './application/conversation-usage-reconcile.js';
import { ConversationRetentionStore } from './application/ports/conversation-retention-store.js';
import { ConversationUsageReconcileStore } from './application/ports/conversation-usage-reconcile-store.js';
import { ConversationRetentionSqlStore } from './infra/db/conversation-retention.sql-store.js';
import { ConversationUsageReconcileSqlStore } from './infra/db/conversation-usage-reconcile.sql-store.js';
import { AgentTurn } from './application/agent-turn.js';
import { ChangeConversationStateUseCase } from './application/change-conversation-state.use-case.js';
import { ChangeExecutorUseCase } from './application/change-executor.use-case.js';
import { ConversationAccess } from './application/conversation-access.js';
import { ConversationDeparture } from './application/conversation-departure.js';
import { ConversationExecutors } from './application/conversation-executors.js';
import { ConversationViews } from './application/conversation-views.js';
import { ConversationStorageUsage } from './application/conversation-storage-usage.js';
import { CreateConversationUseCase } from './application/create-conversation.use-case.js';
import { DeleteAttachmentUseCase } from './application/delete-attachment.use-case.js';
import { DeleteMessageUseCase } from './application/delete-message.use-case.js';
import { EmptyConversationTrashUseCase } from './application/empty-conversation-trash.use-case.js';
import { MoveConversationUseCase } from './application/move-conversation.use-case.js';
import { ConversationsExecutorLostHook } from './application/executor-lost.hook.js';
import { GetConversationUseCase } from './application/get-conversation.use-case.js';
import { HubCreateConversationUseCase } from './application/hub-create-conversation.use-case.js';
import { LeaveConversationUseCase } from './application/leave-conversation.use-case.js';
import { RotateConversationKeyUseCase } from './application/rotate-conversation-key.use-case.js';
import { ReplaceConversationHeaderUseCase } from './application/replace-conversation-header.use-case.js';
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
import { HubConversationScope } from './application/hub-conversation-scope.js';
import { CloudConversationExecutor } from './application/cloud-conversation-executor.js';
import { ConversationsCloudDeactivatedHook } from './application/cloud-deactivated.hook.js';
import { ConversationCloudReserve } from './application/conversation-cloud-reserve.js';
import { SetCloudAnswerUseCase } from './application/set-cloud-answer.use-case.js';
import { SetCloudReserveUseCase } from './application/set-cloud-reserve.use-case.js';

/**
 * Conversations ("assuntos") as space data (spec 2026-11-09-conversations): encrypted with their own key, private to
 * their participants and executor Hub. Depends on `identity` (CurrentAuthProofVerifier, to empty a conversation's
 * trash), `spaces` (SpaceAccess, SpaceStorage, and the SpaceStorageUsage
 * port, where it registers the message and attachment bytes), `hubs` (HubDirectory, HubAccess), `organizations`
 * (AuditLog) and `storage` (the ObjectStore port and the shared upload/repair pieces of `application/object-uploads`)
 * through what they export; reacts to `SpaceMemberLeftHooks`, `HubExecutorLostHooks` and `SpaceCloudDeactivatedHooks`,
 * joins the `storage:reconcile` sweep through `StorageReconcileHooks`, and emits `CloudReservePendingHooks`.
 * Exports `HubConversationScope` (the (organization, space) of a conversation a Hub executes) for the `agents` module,
 * `CloudConversationExecutor` (the cloud as reserve executor, spec active-cloud §4.3) and `AgentTurn` (the pc agent's
 * turn on a message and its ack lease, spec pc-agent §5.3) for the `cloud` module; runs the lease sweep
 * (`AgentLeaseSweepJob`), the retention (`ConversationRetention`) and the usage counter recount
 * (`ConversationUsageReconcile`), all pg-boss crons;
 * `conversations` never imports `cloud` (the server copies are checked through `ServerKeyCopyCheck`).
 */
@Module({
  imports: [
    IdentityModule,
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
    ReplaceConversationHeaderUseCase,
    AckMessageUseCase,
    DeleteMessageUseCase,
    ConversationAttachmentHealer,
    ReconcileConversationAttachments,
    RequestAttachmentUploadUseCase,
    ConfirmAttachmentUseCase,
    GetAttachmentDownloadUrlUseCase,
    DeleteAttachmentUseCase,
    MoveConversationUseCase,
    EmptyConversationTrashUseCase,
    ConversationCloudReserve,
    ConversationsCloudDeactivatedHook,
    SetCloudReserveUseCase,
    SetCloudAnswerUseCase,
    CloudConversationExecutor,
    HubConversationScope,
    AgentTurn,
    AgentLeaseSweepJob,
    ConversationRetention,
    {
      provide: ConversationRetentionStore,
      useClass: ConversationRetentionSqlStore,
    },
    ConversationUsageReconcile,
    {
      provide: ConversationUsageReconcileStore,
      useClass: ConversationUsageReconcileSqlStore,
    },
  ],
  exports: [CloudConversationExecutor, HubConversationScope, AgentTurn],
})
export class ConversationsModule {}
