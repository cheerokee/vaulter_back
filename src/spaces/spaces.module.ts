import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityModule } from '../identity/identity.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
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
  ],
})
export class SpacesModule {}
