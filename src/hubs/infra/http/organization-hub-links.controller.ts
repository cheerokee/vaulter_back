import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type AuthContext,
  CurrentAuth,
} from '../../../shared/infra/http/auth.decorators.js';
import { pageResponse } from '../../../shared/infra/http/cursor-pagination.query.js';
import { uuidPipe } from '../../../shared/infra/http/uuid-pipe.js';
import { ListOrganizationHubLinksUseCase } from '../../application/list-organization-hub-links.use-case.js';
import { OrganizationHubLinksQuery } from './dto/hub.dto.js';
import { organizationHubLinkResponse } from './dto/responses.js';

// Lado da organização dos vínculos de Hub: mora no `hubs` (o `organizations` nunca importa `hubs`), sob o caminho da
// organização. Rota interna do app (sem a tag `public`), só token de usuário.
@ApiTags('hubs')
@Controller('organizations')
export class OrganizationHubLinksController {
  constructor(private readonly list: ListOrganizationHubLinksUseCase) {}

  /**
   * Hub links and requests of the organization, for an admin with `org.hubs.approve` (404 for a non-member, 403
   * without the permission). The way an admin finds the `hubId` of a pending request to approve or reject it.
   * Ordered by hub id (cursor); `status` filters.
   */
  @ApiBearerAuth()
  @Get(':orgId/hub-links')
  async doList(
    @CurrentAuth() auth: AuthContext,
    @Param('orgId', uuidPipe('orgId')) orgId: string,
    @Query() query: OrganizationHubLinksQuery,
  ) {
    return pageResponse(
      await this.list.execute(auth, orgId, {
        cursor: query.cursor,
        limit: query.limit,
        status: query.status,
      }),
      organizationHubLinkResponse,
    );
  }
}
