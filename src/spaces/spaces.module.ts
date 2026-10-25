import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityModule } from '../identity/identity.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { AddSpaceMemberUseCase } from './application/add-space-member.use-case.js';
import { ChangeSpaceMemberRoleUseCase } from './application/change-space-member-role.use-case.js';
import { CreateSpaceUseCase } from './application/create-space.use-case.js';
import { DeclinePendingGrantUseCase } from './application/decline-pending-grant.use-case.js';
import { GetMyKeysUseCase } from './application/get-my-keys.use-case.js';
import { GetRecoveryCopiesUseCase } from './application/get-recovery-copies.use-case.js';
import { GetSpaceUseCase } from './application/get-space.use-case.js';
import { SpacesInvitationHook } from './application/invitation.hook.js';
import { LeaveSpaceUseCase } from './application/leave-space.use-case.js';
import { ListPendingGrantsUseCase } from './application/list-pending-grants.use-case.js';
import { ListSpaceMembersUseCase } from './application/list-space-members.use-case.js';
import { ListSpacesUseCase } from './application/list-spaces.use-case.js';
import { SpacesMemberRemovedHook } from './application/member-removed.hook.js';
import { PromoteSpaceManagerUseCase } from './application/promote-space-manager.use-case.js';
import { RecoverOrphanSpaceUseCase } from './application/recover-orphan-space.use-case.js';
import { RecoveryKit } from './application/recovery-kit.js';
import { RenameSpaceUseCase } from './application/rename-space.use-case.js';
import { RemoveSpaceMemberUseCase } from './application/remove-space-member.use-case.js';
import { RewrapRecoveryUseCase } from './application/rewrap-recovery.use-case.js';
import { RotateSpaceKeyUseCase } from './application/rotate-space-key.use-case.js';
import { SpaceAccess } from './application/space-access.js';
import { KeyFingerprinter } from './application/ports/key-fingerprinter.js';
import { PendingGrantRepository } from './domain/pending-grant.repository.js';
import { SpaceGrantRepository } from './domain/space-grant.repository.js';
import { SpaceIntentRepository } from './domain/space-intent.repository.js';
import { SpaceKeyRepository } from './domain/space-key.repository.js';
import { SpaceRoleRepository } from './domain/space-role.repository.js';
import { SpaceRepository } from './domain/space.repository.js';
import { SodiumKeyFingerprinter } from './infra/crypto/sodium-key-fingerprinter.js';
import { InvitationSpaceIntentTypeormEntity } from './infra/db/invitation-space-intent.entity.js';
import { PendingGrantTypeormRepository } from './infra/db/pending-grant.typeorm-repository.js';
import { SpaceGrantTypeormRepository } from './infra/db/space-grant.typeorm-repository.js';
import { SpaceIntentTypeormRepository } from './infra/db/space-intent.typeorm-repository.js';
import { SpaceKeyGrantTypeormEntity } from './infra/db/space-key-grant.entity.js';
import { SpaceKeyTypeormEntity } from './infra/db/space-key.entity.js';
import { SpaceKeyTypeormRepository } from './infra/db/space-key.typeorm-repository.js';
import { SpacePendingGrantTypeormEntity } from './infra/db/space-pending-grant.entity.js';
import { SpaceRoleTypeormRepository } from './infra/db/space-role.typeorm-repository.js';
import { SpaceTypeormEntity } from './infra/db/space.entity.js';
import { SpaceTypeormRepository } from './infra/db/space.typeorm-repository.js';
import { SpaceKeysController } from './infra/http/space-keys.controller.js';
import { SpaceMembersController } from './infra/http/space-members.controller.js';
import { SpacesController } from './infra/http/spaces.controller.js';

@Module({
  imports: [
    // Uma direção só: spaces usa o que organizations e identity exportam; nenhum dos dois importa spaces.
    OrganizationsModule,
    IdentityModule,
    TypeOrmModule.forFeature([
      SpaceTypeormEntity,
      SpaceKeyTypeormEntity,
      SpaceKeyGrantTypeormEntity,
      SpacePendingGrantTypeormEntity,
      InvitationSpaceIntentTypeormEntity,
    ]),
  ],
  controllers: [SpacesController, SpaceMembersController, SpaceKeysController],
  providers: [
    { provide: SpaceRepository, useClass: SpaceTypeormRepository },
    { provide: SpaceKeyRepository, useClass: SpaceKeyTypeormRepository },
    { provide: SpaceGrantRepository, useClass: SpaceGrantTypeormRepository },
    { provide: SpaceRoleRepository, useClass: SpaceRoleTypeormRepository },
    {
      provide: PendingGrantRepository,
      useClass: PendingGrantTypeormRepository,
    },
    { provide: SpaceIntentRepository, useClass: SpaceIntentTypeormRepository },
    { provide: KeyFingerprinter, useClass: SodiumKeyFingerprinter },
    AddSpaceMemberUseCase,
    ChangeSpaceMemberRoleUseCase,
    CreateSpaceUseCase,
    DeclinePendingGrantUseCase,
    GetMyKeysUseCase,
    GetRecoveryCopiesUseCase,
    GetSpaceUseCase,
    SpacesInvitationHook,
    LeaveSpaceUseCase,
    ListPendingGrantsUseCase,
    ListSpaceMembersUseCase,
    ListSpacesUseCase,
    SpacesMemberRemovedHook,
    PromoteSpaceManagerUseCase,
    RecoverOrphanSpaceUseCase,
    RecoveryKit,
    RenameSpaceUseCase,
    RemoveSpaceMemberUseCase,
    RewrapRecoveryUseCase,
    RotateSpaceKeyUseCase,
    SpaceAccess,
  ],
  // Para os próximos módulos (storage, hubs): checagem de acesso ao espaço.
  exports: [SpaceAccess],
})
export class SpacesModule {}
