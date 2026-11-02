import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
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
import { ThrottleByUser } from '../../../shared/infra/http/throttling.decorators.js';
import { uuidPipe } from '../../../shared/infra/http/uuid-pipe.js';
import { AssignHubRoleUseCase } from '../../application/assign-hub-role.use-case.js';
import { ClaimHubUseCase } from '../../application/claim-hub.use-case.js';
import { DeregisterHubUseCase } from '../../application/deregister-hub.use-case.js';
import { GetHubUseCase } from '../../application/get-hub.use-case.js';
import { ListHubsUseCase } from '../../application/list-hubs.use-case.js';
import { RemoveHubRoleUseCase } from '../../application/remove-hub-role.use-case.js';
import { RenameHubUseCase } from '../../application/rename-hub.use-case.js';
import { AssignHubRoleDto, ClaimHubDto, RenameHubDto } from './dto/hub.dto.js';
import {
  hubResponse,
  hubRoleResponse,
  hubWithRoleResponse,
} from './dto/responses.js';

// Rotas internas do app (sem a tag `public`). Só token de usuário: o de Hub é recusado pelo guard de usuário.
// Hub que a pessoa não vê: 404 `hub-not-found`; ação sem permissão num Hub que ela vê: 403.
@ApiTags('hubs')
@Controller('hubs')
export class HubsController {
  constructor(
    private readonly claim: ClaimHubUseCase,
    private readonly list: ListHubsUseCase,
    private readonly get: GetHubUseCase,
    private readonly rename: RenameHubUseCase,
    private readonly deregister: DeregisterHubUseCase,
    private readonly assignRole: AssignHubRoleUseCase,
    private readonly removeRole: RemoveHubRoleUseCase,
  ) {}

  /** The owner claims a device by its 8-digit code. Every code failure is the same 422 `claim-code-invalid`. */
  @Throttle({ default: RATE_LIMITS.hubClaimIp })
  @ThrottleByUser(RATE_LIMITS.hubClaimUser)
  @ApiBearerAuth()
  @Post('claim')
  async doClaim(@CurrentAuth() auth: AuthContext, @Body() dto: ClaimHubDto) {
    return hubResponse(
      await this.claim.execute(auth, {
        claimCode: dto.claimCode,
        name: dto.name,
      }),
    );
  }

  /** My hubs (owner) and the hubs linked (approved) to my organizations, with my role on each. */
  @ApiBearerAuth()
  @Get()
  async doList(
    @CurrentAuth() auth: AuthContext,
    @Query() query: CursorPaginationQuery,
  ) {
    return pageResponse(
      await this.list.execute(auth, {
        cursor: query.cursor,
        limit: query.limit,
      }),
      hubWithRoleResponse,
    );
  }

  @ApiBearerAuth()
  @Get(':id')
  async doGet(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
  ) {
    return hubWithRoleResponse(await this.get.execute(auth, id));
  }

  @ApiBearerAuth()
  @Patch(':id')
  async doRename(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: RenameHubDto,
  ) {
    return hubWithRoleResponse(
      await this.rename.execute(auth, { hubId: id, name: dto.name }),
    );
  }

  /** Deregisters (owner only): tombstones everything of the hub in one transaction; its token stops working. */
  @ApiBearerAuth()
  @Delete(':id')
  @HttpCode(204)
  async doDeregister(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
  ): Promise<void> {
    await this.deregister.execute(auth, id);
  }

  /** Owner gives `hub_operator` / `hub_user` to a member of a linked organization. */
  @ApiBearerAuth()
  @Put(':id/roles/:userId')
  async doAssignRole(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Param('userId', uuidPipe('userId')) userId: string,
    @Body() dto: AssignHubRoleDto,
  ) {
    return hubRoleResponse(
      await this.assignRole.execute(auth, {
        hubId: id,
        userId,
        roleKey: dto.roleKey,
      }),
    );
  }

  /**
   * Owner removes the explicit hub role of a person: 204 whether there was a role or not (idempotent, like a PUT
   * that converges; the person falls back to the implicit `hub_user` while a member of a linked organization).
   */
  @ApiBearerAuth()
  @Delete(':id/roles/:userId')
  @HttpCode(204)
  async doRemoveRole(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Param('userId', uuidPipe('userId')) userId: string,
  ): Promise<void> {
    await this.removeRole.execute(auth, { hubId: id, userId });
  }
}
