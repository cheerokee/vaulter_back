import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
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
import { LinkCodeTypeormRepository } from './infra/db/link-code.typeorm-repository.js';

@Module({
  imports: [
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
  ],
})
export class HubsModule {}
