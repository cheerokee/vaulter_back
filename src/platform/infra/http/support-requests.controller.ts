import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type AuthContext,
  CurrentAuth,
} from '../../../shared/infra/http/auth.decorators.js';
import { pageResponse } from '../../../shared/infra/http/cursor-pagination.query.js';
import { ThrottleReauth } from '../../../shared/infra/http/throttling.decorators.js';
import { uuidPipe } from '../../../shared/infra/http/uuid-pipe.js';
import { CreateSupportRequestUseCase } from '../../application/create-support-request.use-case.js';
import { DecideSupportRequestUseCase } from '../../application/decide-support-request.use-case.js';
import { GetSupportRequestUseCase } from '../../application/get-support-request.use-case.js';
import { ListSupportRequestsUseCase } from '../../application/list-support-requests.use-case.js';
import { supportRequestResponse } from './dto/responses.js';
import {
  ApproveSupportRequestDto,
  CreateSupportRequestDto,
  ListSupportRequestsQuery,
  RejectSupportRequestDto,
} from './dto/support-request.dto.js';
import { RequirePlatformPermission } from './platform-permission.decorator.js';
import { PlatformPermissionGuard } from './platform-permission.guard.js';

// Pedidos de suporte da equipe (spec de papéis da plataforma §4.3). Sem a permissão da rota: o 404 de rota
// inexistente (PlatformPermissionGuard). Mutações pedem reautenticação (`currentAuthProof`, orçamento `reauth`).
@ApiTags('platform')
@UseGuards(PlatformPermissionGuard)
@Controller('platform/support-requests')
export class SupportRequestsController {
  constructor(
    private readonly create: CreateSupportRequestUseCase,
    private readonly decide: DecideSupportRequestUseCase,
    private readonly list: ListSupportRequestsUseCase,
    private readonly get: GetSupportRequestUseCase,
  ) {}

  /** 201 with the request in its final state: `pending`, or `executed`/`failed` for whoever may execute alone. */
  @ApiBearerAuth()
  @RequirePlatformPermission('platform.support.request')
  @ThrottleReauth()
  @Post()
  async doCreate(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: CreateSupportRequestDto,
  ) {
    return supportRequestResponse(
      await this.create.execute(auth, {
        type: dto.type,
        hubId: dto.hubId,
        organizationId: dto.organizationId,
        userId: dto.userId,
        reason: dto.reason,
        evidence: dto.evidence,
        currentAuthProof: dto.currentAuthProof,
      }),
    );
  }

  @ApiBearerAuth()
  @RequirePlatformPermission('platform.audit.read')
  @Get()
  async doList(
    @CurrentAuth() auth: AuthContext,
    @Query() query: ListSupportRequestsQuery,
  ) {
    const page = await this.list.execute(auth, {
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
    return pageResponse(page, supportRequestResponse);
  }

  @ApiBearerAuth()
  @RequirePlatformPermission('platform.audit.read')
  @Get(':id')
  async doGet(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
  ) {
    return supportRequestResponse(await this.get.execute(auth, id));
  }

  /** Approves and executes at once: 200 with `executed` or `failed` (with `failureType`). */
  @ApiBearerAuth()
  @RequirePlatformPermission('platform.support.approve')
  @ThrottleReauth()
  @Post(':id/approve')
  @HttpCode(200)
  async doApprove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: ApproveSupportRequestDto,
  ) {
    return supportRequestResponse(
      await this.decide.approve(auth, id, {
        currentAuthProof: dto.currentAuthProof,
      }),
    );
  }

  @ApiBearerAuth()
  @RequirePlatformPermission('platform.support.approve')
  @ThrottleReauth()
  @Post(':id/reject')
  @HttpCode(200)
  async doReject(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: RejectSupportRequestDto,
  ) {
    return supportRequestResponse(
      await this.decide.reject(auth, id, {
        note: dto.note,
        currentAuthProof: dto.currentAuthProof,
      }),
    );
  }
}
