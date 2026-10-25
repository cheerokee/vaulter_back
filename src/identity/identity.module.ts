import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccessTokenService } from './application/ports/access-token-service.js';
import { AuthProofHasher } from './application/ports/auth-proof-hasher.js';
import { DecoySaltFactory } from './application/ports/decoy-salt-factory.js';
import { RefreshTokenCodec } from './application/ports/refresh-token-codec.js';
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

@Module({
  imports: [
    TypeOrmModule.forFeature([UserTypeormEntity, UserSessionTypeormEntity]),
  ],
  providers: [
    { provide: UserRepository, useClass: UserTypeormRepository },
    { provide: SessionRepository, useClass: UserSessionTypeormRepository },
    { provide: AuthProofHasher, useClass: SodiumAuthProofHasher },
    { provide: AccessTokenService, useClass: JoseAccessTokenService },
    { provide: RefreshTokenCodec, useClass: SodiumRefreshTokenCodec },
    { provide: DecoySaltFactory, useClass: SodiumDecoySaltFactory },
  ],
})
export class IdentityModule {}
