import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccessTokenService } from './application/ports/access-token-service.js';
import { AuthProofHasher } from './application/ports/auth-proof-hasher.js';
import { DecoySaltFactory } from './application/ports/decoy-salt-factory.js';
import { RefreshTokenCodec } from './application/ports/refresh-token-codec.js';
import { AuthenticateAccessTokenUseCase } from './application/authenticate-access-token.use-case.js';
import { RefreshSessionUseCase } from './application/refresh-session.use-case.js';
import { LogoutUseCase } from './application/logout.use-case.js';
import { ListSessionsUseCase } from './application/list-sessions.use-case.js';
import { RevokeSessionUseCase } from './application/revoke-session.use-case.js';
import { GetMeUseCase } from './application/get-me.use-case.js';
import { ChangePasswordUseCase } from './application/change-password.use-case.js';
import { LoginUseCase } from './application/login.use-case.js';
import { PreLoginUseCase } from './application/pre-login.use-case.js';
import { RegisterUserUseCase } from './application/register-user.use-case.js';
import { SessionIssuer } from './application/session-issuer.js';
import { SessionRepository } from './domain/session.repository.js';
import { UserRepository } from './domain/user.repository.js';
import { JoseAccessTokenService } from './infra/crypto/jose-access-token-service.js';
import { SodiumAuthProofHasher } from './infra/crypto/sodium-auth-proof-hasher.js';
import { SodiumDecoySaltFactory } from './infra/crypto/sodium-decoy-salt-factory.js';
import { SodiumRefreshTokenCodec } from './infra/crypto/sodium-refresh-token-codec.js';
import { UserSessionTypeormEntity } from './infra/db/user-session.entity.js';
import { UserSessionTypeormRepository } from './infra/db/user-session.typeorm-repository.js';
import { UserTypeormEntity } from './infra/db/user.entity.js';
import { UserTypeormRepository } from './infra/db/user.typeorm-repository.js';
import { AccessTokenGuard } from './infra/http/access-token.guard.js';
import { AuthController } from './infra/http/auth.controller.js';
import { MeController } from './infra/http/me.controller.js';
import { SessionsController } from './infra/http/sessions.controller.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserTypeormEntity, UserSessionTypeormEntity]),
  ],
  controllers: [AuthController, SessionsController, MeController],
  providers: [
    { provide: APP_GUARD, useClass: AccessTokenGuard },
    { provide: UserRepository, useClass: UserTypeormRepository },
    { provide: SessionRepository, useClass: UserSessionTypeormRepository },
    { provide: AuthProofHasher, useClass: SodiumAuthProofHasher },
    { provide: AccessTokenService, useClass: JoseAccessTokenService },
    { provide: RefreshTokenCodec, useClass: SodiumRefreshTokenCodec },
    { provide: DecoySaltFactory, useClass: SodiumDecoySaltFactory },
    SessionIssuer,
    PreLoginUseCase,
    RegisterUserUseCase,
    LoginUseCase,
    AuthenticateAccessTokenUseCase,
    RefreshSessionUseCase,
    LogoutUseCase,
    ListSessionsUseCase,
    RevokeSessionUseCase,
    GetMeUseCase,
    ChangePasswordUseCase,
  ],
})
export class IdentityModule {}
