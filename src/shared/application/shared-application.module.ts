import { Global, Module } from '@nestjs/common';
import { AiBudgetRaisedHooks } from './ai-budget-raised-hooks.js';
import { BackupObjectsChangedHooks } from './backup-objects-changed-hooks.js';
import { CloudReservePendingHooks } from './cloud-reserve-pending-hooks.js';
import { HubExecutorLostHooks } from './hub-executor-lost-hooks.js';
import { InvitationHooks } from './invitation-hooks.js';
import { MemberRemovedHooks } from './member-removed-hooks.js';
import { RegistrationHooks } from './registration-hooks.js';
import { ServerKeyCopyCheck } from './server-key-copy-check.js';
import { SpaceCloudDeactivatedHooks } from './space-cloud-deactivated-hooks.js';
import { SpaceMemberLeftHooks } from './space-member-left-hooks.js';
import { SpaceKeyRotatedHooks } from './space-key-rotated-hooks.js';
import { SpaceQuotaHooks } from './space-quota-hooks.js';
import { StorageReconcileHooks } from './storage-reconcile-hooks.js';

@Global()
@Module({
  providers: [
    RegistrationHooks,
    MemberRemovedHooks,
    InvitationHooks,
    SpaceMemberLeftHooks,
    SpaceQuotaHooks,
    SpaceKeyRotatedHooks,
    HubExecutorLostHooks,
    StorageReconcileHooks,
    BackupObjectsChangedHooks,
    AiBudgetRaisedHooks,
    ServerKeyCopyCheck,
    SpaceCloudDeactivatedHooks,
    CloudReservePendingHooks,
  ],
  exports: [
    RegistrationHooks,
    MemberRemovedHooks,
    InvitationHooks,
    SpaceMemberLeftHooks,
    SpaceQuotaHooks,
    SpaceKeyRotatedHooks,
    HubExecutorLostHooks,
    StorageReconcileHooks,
    BackupObjectsChangedHooks,
    AiBudgetRaisedHooks,
    ServerKeyCopyCheck,
    SpaceCloudDeactivatedHooks,
    CloudReservePendingHooks,
  ],
})
export class SharedApplicationModule {}
