import { Global, Module } from '@nestjs/common';
import { RegistrationHooks } from './registration-hooks.js';

@Global()
@Module({ providers: [RegistrationHooks], exports: [RegistrationHooks] })
export class SharedApplicationModule {}
