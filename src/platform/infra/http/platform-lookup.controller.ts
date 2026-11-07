import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type AuthContext,
  CurrentAuth,
} from '../../../shared/infra/http/auth.decorators.js';
import { uuidPipe } from '../../../shared/infra/http/uuid-pipe.js';
import {
  LookupHubUseCase,
  LookupOrganizationUseCase,
  LookupUserUseCase,
} from '../../application/lookup.use-cases.js';
import { LookupUserQuery } from './dto/lookup.dto.js';
import {
  PlatformRoutes,
  RequirePlatformPermission,
} from './platform-permission.decorator.js';

// Consultas do suporte para montar um pedido (spec de papéis da plataforma §4.1): só leitura, sem chaves.
@ApiTags('platform')
@PlatformRoutes()
@Controller('platform/lookup')
export class PlatformLookupController {
  constructor(
    private readonly user: LookupUserUseCase,
    private readonly hub: LookupHubUseCase,
    private readonly org: LookupOrganizationUseCase,
  ) {}

  @ApiBearerAuth()
  @RequirePlatformPermission('platform.support.request')
  @Get('users')
  doUser(@CurrentAuth() auth: AuthContext, @Query() query: LookupUserQuery) {
    return this.user.execute(auth.userId, query.email);
  }

  @ApiBearerAuth()
  @RequirePlatformPermission('platform.support.request')
  @Get('hubs/:hubId')
  async doHub(
    @CurrentAuth() auth: AuthContext,
    @Param('hubId', uuidPipe('hubId')) hubId: string,
  ) {
    const s = await this.hub.execute(auth.userId, hubId);
    return {
      hubId: s.hubId,
      name: s.name,
      ownerUserId: s.ownerUserId,
      deregistered: s.deregistered,
      organizationIds: s.organizationIds,
    };
  }

  @ApiBearerAuth()
  @RequirePlatformPermission('platform.support.request')
  @Get('organizations/:orgId')
  async doOrganization(
    @CurrentAuth() auth: AuthContext,
    @Param('orgId', uuidPipe('orgId')) orgId: string,
  ) {
    const s = await this.org.execute(auth.userId, orgId);
    return {
      organizationId: s.organizationId,
      name: s.name,
      personal: s.personal,
      adminUserIds: s.adminUserIds,
      memberCount: s.memberCount,
    };
  }
}
