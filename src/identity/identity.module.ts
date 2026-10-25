import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SessionRepository } from './domain/session.repository.js';
import { UserRepository } from './domain/user.repository.js';
import { UserSessionTypeormEntity } from './infra/db/user-session.entity.js';
import { UserSessionTypeormRepository } from './infra/db/user-session.typeorm-repository.js';
import { UserTypeormEntity } from './infra/db/user.entity.js';
import { UserTypeormRepository } from './infra/db/user.typeorm-repository.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserTypeormEntity, UserSessionTypeormEntity]),
  ],
  providers: [
    { provide: UserRepository, useClass: UserTypeormRepository },
    { provide: SessionRepository, useClass: UserSessionTypeormRepository },
  ],
})
export class IdentityModule {}
