import { Global, Module } from '@nestjs/common';
import { InvitationHooks } from './invitation-hooks.js';
import { MemberRemovedHooks } from './member-removed-hooks.js';
import { RegistrationHooks } from './registration-hooks.js';
import { SpaceMemberLeftHooks } from './space-member-left-hooks.js';

@Global()
@Module({
  providers: [
    RegistrationHooks,
    MemberRemovedHooks,
    InvitationHooks,
    SpaceMemberLeftHooks,
  ],
  exports: [
    RegistrationHooks,
    MemberRemovedHooks,
    InvitationHooks,
    SpaceMemberLeftHooks,
  ],
})
export class SharedApplicationModule {}
