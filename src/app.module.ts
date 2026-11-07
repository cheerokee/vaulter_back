import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SentryModule } from '@sentry/nestjs/setup';
import { LoggerModule } from 'nestjs-pino';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DatabaseModule } from './database/database.module.js';
import { SharedApplicationModule } from './shared/application/shared-application.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { OrganizationsModule } from './organizations/organizations.module.js';
import { SpacesModule } from './spaces/spaces.module.js';
import { HubsModule } from './hubs/hubs.module.js';
import { PlatformModule } from './platform/platform.module.js';
import { pinoHttpOptions } from './shared/infra/observability/logger.config.js';
import { ThrottlingModule } from './shared/infra/http/throttling.module.js';
import { validateEnv } from './shared/infra/config/env.validation.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: pinoHttpOptions(config),
      }),
    }),
    SentryModule.forRoot(),
    DatabaseModule,
    SharedApplicationModule,
    IdentityModule,
    OrganizationsModule,
    SpacesModule,
    HubsModule,
    PlatformModule,
    // Depois do IdentityModule e do HubsModule: os guards de token (usuário e Hub) rodam antes do throttler, que
    // conta por usuário/Hub (fixado por test/shared/rate-limit e test/hubs/rate-limit).
    ThrottlingModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
