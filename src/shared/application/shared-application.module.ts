import { Global, Module } from '@nestjs/common';
import { InvitationHooks } from './invitation-hooks.js';
import { MemberRemovedHooks } from './member-removed-hooks.js';
import { RegistrationHooks } from './registration-hooks.js';

@Global()
@Module({
  providers: [RegistrationHooks, MemberRemovedHooks, InvitationHooks],
  exports: [RegistrationHooks, MemberRemovedHooks, InvitationHooks],
})
export class SharedApplicationModule {}
