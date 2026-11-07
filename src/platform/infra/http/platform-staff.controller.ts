import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type AuthContext,
  CurrentAuth,
} from '../../../shared/infra/http/auth.decorators.js';
import {
  CursorPaginationQuery,
  pageResponse,
} from '../../../shared/infra/http/cursor-pagination.query.js';
import { ThrottleReauth } from '../../../shared/infra/http/throttling.decorators.js';
import { uuidPipe } from '../../../shared/infra/http/uuid-pipe.js';
import { GrantPlatformRoleUseCase } from '../../application/grant-platform-role.use-case.js';
import { ListStaffUseCase } from '../../application/list-staff.use-case.js';
import { RevokePlatformRoleUseCase } from '../../application/revoke-platform-role.use-case.js';
import type { PlatformRoleKey } from '../../domain/platform-catalog.js';
import {
  PlatformRoleChangeDto,
  platformRoleKeyPipe,
} from './dto/platform.dto.js';
import { staffMemberResponse } from './dto/responses.js';
import {
  PlatformRoutes,
  RequirePlatformPermission,
} from './platform-permission.decorator.js';

@ApiTags('platform')
@PlatformRoutes()
@Controller('platform/staff')
export class PlatformStaffController {
  constructor(
    private readonly list: ListStaffUseCase,
    private readonly grant: GrantPlatformRoleUseCase,
    private readonly revoke: RevokePlatformRoleUseCase,
  ) {}

  @ApiBearerAuth()
  @RequirePlatformPermission('platform.roles.manage')
  @Get()
  async doList(
    @CurrentAuth() auth: AuthContext,
    @Query() query: CursorPaginationQuery,
  ) {
    const page = await this.list.execute(auth, {
      cursor: query.cursor,
      limit: query.limit,
    });
    return pageResponse(page, staffMemberResponse);
  }

  @ApiBearerAuth()
  @RequirePlatformPermission('platform.roles.manage')
  @ThrottleReauth()
  @Put(':userId/roles/:roleKey')
  @HttpCode(204)
  async doGrant(
    @CurrentAuth() auth: AuthContext,
    @Param('userId', uuidPipe('userId')) userId: string,
    @Param('roleKey', platformRoleKeyPipe) roleKey: PlatformRoleKey,
    @Body() dto: PlatformRoleChangeDto,
  ): Promise<void> {
    await this.grant.execute(auth, userId, roleKey, {
      currentAuthProof: dto.currentAuthProof,
    });
  }

  @ApiBearerAuth()
  @RequirePlatformPermission('platform.roles.manage')
  @ThrottleReauth()
  @Delete(':userId/roles/:roleKey')
  @HttpCode(204)
  async doRevoke(
    @CurrentAuth() auth: AuthContext,
    @Param('userId', uuidPipe('userId')) userId: string,
    @Param('roleKey', platformRoleKeyPipe) roleKey: PlatformRoleKey,
    @Body() dto: PlatformRoleChangeDto,
  ): Promise<void> {
    await this.revoke.execute(auth, userId, roleKey, {
      currentAuthProof: dto.currentAuthProof,
    });
  }
}
