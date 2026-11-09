import { Global, Module } from '@nestjs/common';
import { InvitationHooks } from './invitation-hooks.js';
import { MemberRemovedHooks } from './member-removed-hooks.js';
import { RegistrationHooks } from './registration-hooks.js';
import { SpaceMemberLeftHooks } from './space-member-left-hooks.js';
import { SpaceQuotaHooks } from './space-quota-hooks.js';

@Global()
@Module({
  providers: [
    RegistrationHooks,
    MemberRemovedHooks,
    InvitationHooks,
    SpaceMemberLeftHooks,
    SpaceQuotaHooks,
  ],
  exports: [
    RegistrationHooks,
    MemberRemovedHooks,
    InvitationHooks,
    SpaceMemberLeftHooks,
    SpaceQuotaHooks,
  ],
})
export class SharedApplicationModule {}
