import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type AuthContext,
  CurrentAuth,
} from '../../../shared/infra/http/auth.decorators.js';
import { CursorPaginationQuery } from '../../../shared/infra/http/cursor-pagination.query.js';
import { ListSessionsUseCase } from '../../application/list-sessions.use-case.js';
import { RevokeSessionUseCase } from '../../application/revoke-session.use-case.js';
import { RequestValidationError } from '../../../shared/infra/http/request-validation.error.js';
import { SessionPageResponse } from './dto/session-view-response.dto.js';

const SESSION_ID_PIPE = new ParseUUIDPipe({
  exceptionFactory: () =>
    new RequestValidationError([
      { field: 'id', messages: ['id must be a UUID'] },
    ]),
});

@ApiTags('sessions')
@ApiBearerAuth()
@Controller('sessions')
export class SessionsController {
  constructor(
    private readonly list: ListSessionsUseCase,
    private readonly revoke: RevokeSessionUseCase,
  ) {}

  @Get()
  async doList(
    @CurrentAuth() auth: AuthContext,
    @Query() query: CursorPaginationQuery,
  ): Promise<SessionPageResponse> {
    const page = await this.list.execute(auth, {
      cursor: query.cursor,
      limit: query.limit,
    });
    return SessionPageResponse.from(page);
  }

  @Delete(':id')
  @HttpCode(204)
  async doRevoke(
    @CurrentAuth() auth: AuthContext,
    @Param('id', SESSION_ID_PIPE) id: string,
  ): Promise<void> {
    await this.revoke.execute(auth, id);
  }
}
