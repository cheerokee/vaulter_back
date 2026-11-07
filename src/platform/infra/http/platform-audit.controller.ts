import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type AuthContext,
  CurrentAuth,
} from '../../../shared/infra/http/auth.decorators.js';
import { pageResponse } from '../../../shared/infra/http/cursor-pagination.query.js';
import { ListPlatformAuditUseCase } from '../../application/list-platform-audit.use-case.js';
import { ListPlatformAuditQuery } from './dto/lookup.dto.js';
import { platformAuditResponse } from './dto/responses.js';
import {
  PlatformRoutes,
  RequirePlatformPermission,
} from './platform-permission.decorator.js';

@ApiTags('platform')
@PlatformRoutes()
@Controller('platform/audit')
export class PlatformAuditController {
  constructor(private readonly list: ListPlatformAuditUseCase) {}

  @ApiBearerAuth()
  @RequirePlatformPermission('platform.audit.read')
  @Get()
  async doList(
    @CurrentAuth() auth: AuthContext,
    @Query() query: ListPlatformAuditQuery,
  ) {
    return pageResponse(
      await this.list.execute(auth, {
        supportRequestId: query.supportRequestId,
        cursor: query.cursor,
        limit: query.limit,
      }),
      platformAuditResponse,
    );
  }
}
