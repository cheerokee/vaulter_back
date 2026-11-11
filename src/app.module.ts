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
import { StorageModule } from './storage/storage.module.js';
import { ConversationsModule } from './conversations/conversations.module.js';
import { CloudModule } from './cloud/cloud.module.js';
import { JobsModule } from './shared/infra/jobs/jobs.module.js';
import { JobQueueDrain } from './shared/infra/jobs/job-queue-drain.js';
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
    JobsModule,
    IdentityModule,
    OrganizationsModule,
    SpacesModule,
    HubsModule,
    PlatformModule,
    StorageModule,
    ConversationsModule,
    CloudModule,
    // Depois do IdentityModule, do HubsModule e do PlatformModule: os guards de token (usuário e Hub) rodam antes do
    // throttler, que conta por usuário/Hub (fixado por test/shared/rate-limit e test/hubs/rate-limit), e a trava da
    // plataforma responde o 404 antes de o throttler contar (fixado por test/platform/staff).
    ThrottlingModule,
  ],
  controllers: [AppController],
  // JobQueueDrain: first destroy hook of the app (root module), stops the job workers before anything else is released.
  providers: [AppService, JobQueueDrain],
})
export class AppModule {}
