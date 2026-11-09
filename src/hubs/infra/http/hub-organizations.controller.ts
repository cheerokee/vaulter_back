import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  type AuthContext,
  CurrentAuth,
} from '../../../shared/infra/http/auth.decorators.js';
import {
  CursorPaginationQuery,
  pageResponse,
} from '../../../shared/infra/http/cursor-pagination.query.js';
import { RATE_LIMITS } from '../../../shared/infra/http/rate-limits.js';
import { userIdTracker } from '../../../shared/infra/http/user-id.tracker.js';
import { uuidPipe } from '../../../shared/infra/http/uuid-pipe.js';
import { ApproveHubLinkUseCase } from '../../application/approve-hub-link.use-case.js';
import { IssueLinkCodeUseCase } from '../../application/issue-link-code.use-case.js';
import { LinkHubOrganizationUseCase } from '../../application/link-hub-organization.use-case.js';
import { ListHubLinksUseCase } from '../../application/list-hub-links.use-case.js';
import { RejectHubLinkUseCase } from '../../application/reject-hub-link.use-case.js';
import { RequestHubLinkUseCase } from '../../application/request-hub-link.use-case.js';
import { UnlinkHubOrganizationUseCase } from '../../application/unlink-hub-organization.use-case.js';
import { LinkOrganizationDto, LinkRequestDto } from './dto/hub.dto.js';
import { hubLinkRequestResponse, hubLinkResponse } from './dto/responses.js';
import {
  CurrentHub,
  HubAuth,
  type HubAuthContext,
} from '../../../shared/infra/http/hub-auth.decorators.js';
import { hubIdTracker } from '../../../shared/infra/http/hub-id.tracker.js';

// Vínculos Hub <-> organização (dois consentimentos: dono do Hub e, se a política exigir, admin da organização).
// Rotas internas do app (sem a tag `public`), só token de usuário.
@ApiTags('hubs')
@Controller('hubs')
export class HubOrganizationsController {
  constructor(
    private readonly list: ListHubLinksUseCase,
    private readonly link: LinkHubOrganizationUseCase,
    private readonly request: RequestHubLinkUseCase,
    private readonly approve: ApproveHubLinkUseCase,
    private readonly reject: RejectHubLinkUseCase,
    private readonly unlink: UnlinkHubOrganizationUseCase,
  ) {}

  /**
   * A member of an organization asks to link it to the hub in front of them, with the 8-digit code the hub shows.
   * Every code failure is the same 422 `link-code-invalid`; the response never carries the hub id.
   */
  @Throttle({
    default: { ...RATE_LIMITS.hubLinkRequest, getTracker: userIdTracker },
  })
  @ApiBearerAuth()
  @Post('link-requests')
  async doRequest(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: LinkRequestDto,
  ) {
    return hubLinkRequestResponse(
      await this.request.execute(auth, {
        linkCode: dto.linkCode,
        organizationId: dto.organizationId,
      }),
    );
  }

  /** Links and requests: all of them for the owner; those of the organizations they administer for an admin. */
  @ApiBearerAuth()
  @Get(':id/organizations')
  async doList(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Query() query: CursorPaginationQuery,
  ) {
    return pageResponse(
      await this.list.execute(auth, id, {
        cursor: query.cursor,
        limit: query.limit,
      }),
      hubLinkResponse,
    );
  }

  /** The owner links an organization they belong to (owner consent given; the org policy decides the rest). */
  @ApiBearerAuth()
  @Post(':id/organizations')
  async doLink(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: LinkOrganizationDto,
  ) {
    return hubLinkResponse(
      await this.link.execute(auth, {
        hubId: id,
        organizationId: dto.organizationId,
      }),
    );
  }

  /** Owner and/or org admin (`org.hubs.approve`) consent, according to who calls and what is missing. */
  @ApiBearerAuth()
  @Post(':id/organizations/:orgId/approve')
  @HttpCode(200)
  async doApprove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Param('orgId', uuidPipe('orgId')) orgId: string,
  ) {
    return hubLinkResponse(
      await this.approve.execute(auth, { hubId: id, organizationId: orgId }),
    );
  }

  @ApiBearerAuth()
  @Post(':id/organizations/:orgId/reject')
  @HttpCode(200)
  async doReject(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Param('orgId', uuidPipe('orgId')) orgId: string,
  ) {
    return hubLinkResponse(
      await this.reject.execute(auth, { hubId: id, organizationId: orgId }),
    );
  }

  /** Owner or org admin unlinks: the org's spaces leave the hub, the Room falls, rotation becomes pending. */
  @ApiBearerAuth()
  @Delete(':id/organizations/:orgId')
  @HttpCode(204)
  async doUnlink(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Param('orgId', uuidPipe('orgId')) orgId: string,
  ): Promise<void> {
    await this.unlink.execute(auth, { hubId: id, organizationId: orgId });
  }
}

// Rota do Hub autenticado (prefixo `/hub`, só token de Hub). Interna: sem a tag `public`.
@ApiTags('hubs')
@Controller('hub')
export class HubLinkCodesController {
  constructor(private readonly issue: IssueLinkCodeUseCase) {}

  /** The hub asks for a link code to show or say (8 digits, 10 min, single use; only its keyed hash is stored). */
  @Throttle({
    default: { ...RATE_LIMITS.hubLinkCode, getTracker: hubIdTracker },
  })
  @ApiBearerAuth()
  @HubAuth()
  @Post('link-codes')
  async doIssue(@CurrentHub() hub: HubAuthContext) {
    const r = await this.issue.execute(hub.hubId);
    return { linkCode: r.linkCode, expiresAt: r.expiresAt.toISOString() };
  }
}
