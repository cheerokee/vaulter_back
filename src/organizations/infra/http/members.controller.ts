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
import { CursorPaginationQuery } from '../../../shared/infra/http/cursor-pagination.query.js';
import { ChangeMemberRoleUseCase } from '../../application/change-member-role.use-case.js';
import { LeaveOrganizationUseCase } from '../../application/leave-organization.use-case.js';
import { ListMembersUseCase } from '../../application/list-members.use-case.js';
import { RemoveMemberUseCase } from '../../application/remove-member.use-case.js';
import { ChangeMemberRoleDto } from './dto/member.dto.js';
import { memberResponse, pageResponse } from './dto/responses.js';
import { uuidPipe } from '../../../shared/infra/http/uuid-pipe.js';

@ApiTags('organizations')
@ApiBearerAuth()
@Controller('organizations/:id')
export class MembersController {
  constructor(
    private readonly list: ListMembersUseCase,
    private readonly changeRole: ChangeMemberRoleUseCase,
    private readonly remove: RemoveMemberUseCase,
    private readonly leave: LeaveOrganizationUseCase,
  ) {}

  @Get('members')
  async doList(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Query() query: CursorPaginationQuery,
  ) {
    const page = await this.list.execute(auth, id, {
      cursor: query.cursor,
      limit: query.limit,
    });
    return pageResponse(page, memberResponse);
  }

  @Patch('members/:userId')
  async doChangeRole(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Param('userId', uuidPipe('userId')) userId: string,
    @Body() dto: ChangeMemberRoleDto,
  ) {
    return this.changeRole.execute(auth, id, userId, dto.roleKey);
  }

  @Delete('members/:userId')
  @HttpCode(204)
  async doRemove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Param('userId', uuidPipe('userId')) userId: string,
  ): Promise<void> {
    await this.remove.execute(auth, id, userId);
  }

  @Post('leave')
  @HttpCode(204)
  async doLeave(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
  ): Promise<void> {
    await this.leave.execute(auth, id);
  }
}
