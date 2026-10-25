import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
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
import { uuidPipe } from '../../../shared/infra/http/uuid-pipe.js';
import { AddSpaceMemberUseCase } from '../../application/add-space-member.use-case.js';
import { ChangeSpaceMemberRoleUseCase } from '../../application/change-space-member-role.use-case.js';
import { DeclinePendingGrantUseCase } from '../../application/decline-pending-grant.use-case.js';
import { LeaveSpaceUseCase } from '../../application/leave-space.use-case.js';
import { ListPendingGrantsUseCase } from '../../application/list-pending-grants.use-case.js';
import { ListSpaceMembersUseCase } from '../../application/list-space-members.use-case.js';
import { PromoteSpaceManagerUseCase } from '../../application/promote-space-manager.use-case.js';
import { RemoveSpaceMemberUseCase } from '../../application/remove-space-member.use-case.js';
import {
  AddSpaceMemberDto,
  ChangeSpaceMemberRoleDto,
  PromoteSpaceManagerDto,
} from './dto/member.dto.js';
import { pendingGrantResponse, spaceMemberResponse } from './dto/responses.js';

@ApiTags('spaces')
@Controller('spaces/:id')
export class SpaceMembersController {
  constructor(
    private readonly list: ListSpaceMembersUseCase,
    private readonly add: AddSpaceMemberUseCase,
    private readonly changeRole: ChangeSpaceMemberRoleUseCase,
    private readonly remove: RemoveSpaceMemberUseCase,
    private readonly leave: LeaveSpaceUseCase,
    private readonly promote: PromoteSpaceManagerUseCase,
    private readonly listPending: ListPendingGrantsUseCase,
    private readonly decline: DeclinePendingGrantUseCase,
  ) {}

  @ApiBearerAuth()
  @Get('members')
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
      spaceMemberResponse,
    );
  }

  @ApiBearerAuth()
  @Post('members')
  async doAdd(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: AddSpaceMemberDto,
  ) {
    return this.add.execute(auth, id, {
      userId: dto.userId,
      roleKey: dto.roleKey,
      grants: dto.grants.map((g) => ({
        version: g.version,
        wrappedKey: g.wrappedKey,
      })),
    });
  }

  @ApiBearerAuth()
  @Patch('members/:userId')
  async doChangeRole(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Param('userId', uuidPipe('userId')) userId: string,
    @Body() dto: ChangeSpaceMemberRoleDto,
  ) {
    return this.changeRole.execute(auth, id, userId, dto.roleKey);
  }

  @ApiBearerAuth()
  @Delete('members/:userId')
  @HttpCode(204)
  async doRemove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Param('userId', uuidPipe('userId')) userId: string,
  ): Promise<void> {
    await this.remove.execute(auth, id, userId);
  }

  @ApiBearerAuth()
  @Post('leave')
  @HttpCode(204)
  async doLeave(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
  ): Promise<void> {
    await this.leave.execute(auth, id);
  }

  /** Org admin: promotes an existing member when the space has no manager left. */
  @ApiBearerAuth()
  @Post('managers')
  @HttpCode(200)
  async doPromote(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: PromoteSpaceManagerDto,
  ) {
    return this.promote.execute(auth, id, dto.userId);
  }

  @ApiBearerAuth()
  @Get('pending-grants')
  async doListPending(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Query() query: CursorPaginationQuery,
  ) {
    return pageResponse(
      await this.listPending.execute(auth, id, {
        cursor: query.cursor,
        limit: query.limit,
      }),
      pendingGrantResponse,
    );
  }

  @ApiBearerAuth()
  @Delete('pending-grants/:pendingGrantId')
  @HttpCode(204)
  async doDecline(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Param('pendingGrantId', uuidPipe('pendingGrantId'))
    pendingGrantId: string,
  ): Promise<void> {
    await this.decline.execute(auth, id, pendingGrantId);
  }
}
