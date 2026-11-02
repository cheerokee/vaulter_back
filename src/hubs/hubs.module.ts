import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityModule } from '../identity/identity.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { SpacesModule } from '../spaces/spaces.module.js';
import { AddHubSpaceUseCase } from './application/add-hub-space.use-case.js';
import { ApproveHubLinkUseCase } from './application/approve-hub-link.use-case.js';
import { AssignHubRoleUseCase } from './application/assign-hub-role.use-case.js';
import { DeregisterHubUseCase } from './application/deregister-hub.use-case.js';
import { GetHubUseCase } from './application/get-hub.use-case.js';
import { GrantRoomUseCase } from './application/grant-room.use-case.js';
import { HubAccess } from './application/hub-access.js';
import { HubLinkCascade } from './application/hub-link-cascade.js';
import { HubsMemberRemovedHook } from './application/member-removed.hook.js';
import { HubsSpaceMemberLeftHook } from './application/space-member-left.hook.js';
import { IssueLinkCodeUseCase } from './application/issue-link-code.use-case.js';
import { LinkHubOrganizationUseCase } from './application/link-hub-organization.use-case.js';
import { ListHubLinksUseCase } from './application/list-hub-links.use-case.js';
import { ListHubSpacesUseCase } from './application/list-hub-spaces.use-case.js';
import { ListHubsUseCase } from './application/list-hubs.use-case.js';
import { RejectHubLinkUseCase } from './application/reject-hub-link.use-case.js';
import { RemoveHubRoleUseCase } from './application/remove-hub-role.use-case.js';
import { RemoveHubSpaceUseCase } from './application/remove-hub-space.use-case.js';
import { RenameHubUseCase } from './application/rename-hub.use-case.js';
import { RequestHubLinkUseCase } from './application/request-hub-link.use-case.js';
import { RevokeRoomUseCase } from './application/revoke-room.use-case.js';
import { UnlinkHubOrganizationUseCase } from './application/unlink-hub-organization.use-case.js';
import { SyncHubUseCase } from './application/sync-hub.use-case.js';
import { HubSyncReader } from './application/ports/hub-sync-reader.js';
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
import { HubSyncSqlReader } from './infra/db/hub-sync.sql-reader.js';
import { HubSyncController } from './infra/http/hub-sync.controller.js';
import { HubTokenGuard } from './infra/http/hub-token.guard.js';
import { LinkCodeTypeormRepository } from './infra/db/link-code.typeorm-repository.js';

@Module({
  imports: [
    // Uma direção só: hubs usa o que identity, organizations e spaces exportam; nenhum deles importa hubs.
    IdentityModule,
    OrganizationsModule,
    SpacesModule,
    TypeOrmModule.forFeature([
      HubTypeormEntity,
      HubEnrollmentTypeormEntity,
      HubLinkCodeTypeormEntity,
      HubAuthChallengeTypeormEntity,
      HubOrganizationTypeormEntity,
      HubSpaceTypeormEntity,
    ]),
  ],
  controllers: [HubSyncController],
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
    // Leitura da sincronização: projeção só de leitura sobre tabelas de outros módulos (veja o cabeçalho do arquivo).
    { provide: HubSyncReader, useClass: HubSyncSqlReader },
    EnrollHubUseCase,
    EnrollmentStatusUseCase,
    ClaimHubUseCase,
    IssueHubChallengeUseCase,
    IssueHubTokenUseCase,
    AuthenticateHubTokenUseCase,
    AddHubSpaceUseCase,
    ApproveHubLinkUseCase,
    AssignHubRoleUseCase,
    DeregisterHubUseCase,
    GetHubUseCase,
    GrantRoomUseCase,
    HubAccess,
    HubLinkCascade,
    HubsMemberRemovedHook,
    HubsSpaceMemberLeftHook,
    IssueLinkCodeUseCase,
    LinkHubOrganizationUseCase,
    ListHubLinksUseCase,
    ListHubSpacesUseCase,
    ListHubsUseCase,
    RejectHubLinkUseCase,
    RemoveHubRoleUseCase,
    RemoveHubSpaceUseCase,
    RenameHubUseCase,
    RequestHubLinkUseCase,
    RevokeRoomUseCase,
    UnlinkHubOrganizationUseCase,
    SyncHubUseCase,
  ],
  // Para as próximas tarefas (sincronização, controllers) e módulos: checagem de acesso ao Hub.
  exports: [HubAccess],
})
export class HubsModule {}
