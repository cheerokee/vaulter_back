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
  Public,
} from '../../../shared/infra/http/auth.decorators.js';
import { CursorPaginationQuery } from '../../../shared/infra/http/cursor-pagination.query.js';
import { RATE_LIMITS } from '../../../shared/infra/http/rate-limits.js';
import { AcceptInvitationUseCase } from '../../application/accept-invitation.use-case.js';
import { CreateInvitationUseCase } from '../../application/create-invitation.use-case.js';
import { ListInvitationsUseCase } from '../../application/list-invitations.use-case.js';
import { PreviewInvitationUseCase } from '../../application/preview-invitation.use-case.js';
import { RevokeInvitationUseCase } from '../../application/revoke-invitation.use-case.js';
import {
  CreateInvitationDto,
  InvitationTokenDto,
} from './dto/invitation.dto.js';
import { invitationResponse, pageResponse } from './dto/responses.js';
import { uuidPipe } from '../../../shared/infra/http/uuid-pipe.js';

@ApiTags('organizations')
@Controller()
export class InvitationsController {
  constructor(
    private readonly create: CreateInvitationUseCase,
    private readonly list: ListInvitationsUseCase,
    private readonly revoke: RevokeInvitationUseCase,
    private readonly preview: PreviewInvitationUseCase,
    private readonly accept: AcceptInvitationUseCase,
  ) {}

  @ApiBearerAuth()
  @Post('organizations/:id/invitations')
  async doCreate(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: CreateInvitationDto,
  ) {
    const { invitation, token } = await this.create.execute(auth, id, {
      roleKey: dto.roleKey,
      email: dto.email,
      spaces: dto.spaces,
    });
    return { invitation: invitationResponse(invitation), token };
  }

  @ApiBearerAuth()
  @Get('organizations/:id/invitations')
  async doList(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Query() query: CursorPaginationQuery,
  ) {
    const page = await this.list.execute(auth, id, {
      cursor: query.cursor,
      limit: query.limit,
    });
    return pageResponse(page, invitationResponse);
  }

  @ApiBearerAuth()
  @Delete('organizations/:id/invitations/:invitationId')
  @HttpCode(204)
  async doRevoke(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Param('invitationId', uuidPipe('invitationId')) invitationId: string,
  ): Promise<void> {
    await this.revoke.execute(auth, id, invitationId);
  }

  @Public()
  @Throttle({ default: RATE_LIMITS.invitationPreview })
  @Post('invitations/preview')
  @HttpCode(200)
  async doPreview(@Body() dto: InvitationTokenDto) {
    const p = await this.preview.execute(dto.token);
    return {
      organizationName: p.organizationName,
      invitedByName: p.invitedByName,
      expiresAt: p.expiresAt.toISOString(),
    };
  }

  @Throttle({ default: RATE_LIMITS.invitationAccept })
  @ApiBearerAuth()
  @Post('invitations/accept')
  @HttpCode(200)
  async doAccept(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: InvitationTokenDto,
  ) {
    const r = await this.accept.execute(auth, dto.token);
    return { organizationId: r.organizationId, roleKey: r.roleKey };
  }
}
