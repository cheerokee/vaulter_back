import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityModule } from '../identity/identity.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { AuthenticateHubTokenUseCase } from './application/authenticate-hub-token.use-case.js';
import { ClaimHubUseCase } from './application/claim-hub.use-case.js';
import { EnrollHubUseCase } from './application/enroll-hub.use-case.js';
import { EnrollmentStatusUseCase } from './application/enrollment-status.use-case.js';
import { IssueHubChallengeUseCase } from './application/issue-hub-challenge.use-case.js';
import { IssueHubTokenUseCase } from './application/issue-hub-token.use-case.js';
import { HubCodeHasher } from './application/ports/hub-code-hasher.js';
import { HubSignatureVerifier } from './application/ports/hub-signature-verifier.js';
import { AuthChallengeRepository } from './domain/auth-challenge.repository.js';
import { EnrollmentRepository } from './domain/enrollment.repository.js';
import { HubOrganizationRepository } from './domain/hub-organization.repository.js';
import { HubRoleRepository } from './domain/hub-role.repository.js';
import { HubSpaceRepository } from './domain/hub-space.repository.js';
import { HubRepository } from './domain/hub.repository.js';
import { LinkCodeRepository } from './domain/link-code.repository.js';
import { SodiumHubCodeHasher } from './infra/crypto/sodium-hub-code-hasher.js';
import { SodiumHubSignatureVerifier } from './infra/crypto/sodium-hub-signature-verifier.js';
import { AuthChallengeTypeormRepository } from './infra/db/auth-challenge.typeorm-repository.js';
import { EnrollmentTypeormRepository } from './infra/db/enrollment.typeorm-repository.js';
import { HubAuthChallengeTypeormEntity } from './infra/db/hub-auth-challenge.entity.js';
import { HubEnrollmentTypeormEntity } from './infra/db/hub-enrollment.entity.js';
import { HubLinkCodeTypeormEntity } from './infra/db/hub-link-code.entity.js';
import { HubOrganizationTypeormEntity } from './infra/db/hub-organization.entity.js';
import { HubOrganizationTypeormRepository } from './infra/db/hub-organization.typeorm-repository.js';
import { HubRoleTypeormRepository } from './infra/db/hub-role.typeorm-repository.js';
import { HubSpaceTypeormEntity } from './infra/db/hub-space.entity.js';
import { HubSpaceTypeormRepository } from './infra/db/hub-space.typeorm-repository.js';
import { HubTypeormEntity } from './infra/db/hub.entity.js';
import { HubTypeormRepository } from './infra/db/hub.typeorm-repository.js';
import { HubTokenGuard } from './infra/http/hub-token.guard.js';
import { LinkCodeTypeormRepository } from './infra/db/link-code.typeorm-repository.js';

@Module({
  imports: [
    // Uma direção só: hubs usa o que identity e organizations exportam; nenhum dos dois importa hubs.
    IdentityModule,
    OrganizationsModule,
    TypeOrmModule.forFeature([
      HubTypeormEntity,
      HubEnrollmentTypeormEntity,
      HubLinkCodeTypeormEntity,
      HubAuthChallengeTypeormEntity,
      HubOrganizationTypeormEntity,
      HubSpaceTypeormEntity,
    ]),
  ],
  providers: [
    // Guard global de rotas @HubAuth(). O HubsModule vem antes do ThrottlingModule no AppModule: o token de Hub é
    // conferido antes do rate limit (que, por Hub, lê `request.hub`).
    { provide: APP_GUARD, useClass: HubTokenGuard },
    { provide: HubRepository, useClass: HubTypeormRepository },
    { provide: EnrollmentRepository, useClass: EnrollmentTypeormRepository },
    { provide: LinkCodeRepository, useClass: LinkCodeTypeormRepository },
    {
      provide: AuthChallengeRepository,
      useClass: AuthChallengeTypeormRepository,
    },
    {
      provide: HubOrganizationRepository,
      useClass: HubOrganizationTypeormRepository,
    },
    { provide: HubSpaceRepository, useClass: HubSpaceTypeormRepository },
    { provide: HubRoleRepository, useClass: HubRoleTypeormRepository },
    { provide: HubSignatureVerifier, useClass: SodiumHubSignatureVerifier },
    { provide: HubCodeHasher, useClass: SodiumHubCodeHasher },
    EnrollHubUseCase,
    EnrollmentStatusUseCase,
    ClaimHubUseCase,
    IssueHubChallengeUseCase,
    IssueHubTokenUseCase,
    AuthenticateHubTokenUseCase,
  ],
})
export class HubsModule {}
