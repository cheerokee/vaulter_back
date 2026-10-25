import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type AuthContext,
  CurrentAuth,
} from '../../../shared/infra/http/auth.decorators.js';
import { CursorPaginationQuery } from '../../../shared/infra/http/cursor-pagination.query.js';
import { RequestValidationError } from '../../../shared/infra/http/request-validation.error.js';
import { ThrottleReauth } from '../../../shared/infra/http/throttling.decorators.js';
import { CreateOrganizationUseCase } from '../../application/create-organization.use-case.js';
import { GetOrganizationUseCase } from '../../application/get-organization.use-case.js';
import { ListMyOrganizationsUseCase } from '../../application/list-my-organizations.use-case.js';
import { SetRecoveryKeyUseCase } from '../../application/set-recovery-key.use-case.js';
import { UpdateOrganizationUseCase } from '../../application/update-organization.use-case.js';
import {
  CreateOrganizationDto,
  SetRecoveryKeyDto,
  UpdateOrganizationDto,
} from './dto/organization.dto.js';
import { organizationResponse, pageResponse } from './dto/responses.js';
import { uuidPipe } from '../../../shared/infra/http/uuid-pipe.js';

@ApiTags('organizations')
@ApiBearerAuth()
@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly listMine: ListMyOrganizationsUseCase,
    private readonly create: CreateOrganizationUseCase,
    private readonly get: GetOrganizationUseCase,
    private readonly update: UpdateOrganizationUseCase,
    private readonly setRecoveryKey: SetRecoveryKeyUseCase,
  ) {}

  @Get()
  async doList(
    @CurrentAuth() auth: AuthContext,
    @Query() query: CursorPaginationQuery,
  ) {
    const page = await this.listMine.execute(auth, {
      cursor: query.cursor,
      limit: query.limit,
    });
    return pageResponse(page, organizationResponse);
  }

  @Post()
  async doCreate(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: CreateOrganizationDto,
  ) {
    return organizationResponse(
      await this.create.execute(auth, { name: dto.name }),
    );
  }

  @Get(':id')
  async doGet(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
  ) {
    return organizationResponse(await this.get.execute(auth, id));
  }

  @Patch(':id')
  async doUpdate(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: UpdateOrganizationDto,
  ) {
    if (dto.name === undefined && dto.hubLinkPolicy === undefined) {
      throw new RequestValidationError([
        { field: 'name', messages: ['name or hubLinkPolicy is required'] },
      ]);
    }
    return organizationResponse(
      await this.update.execute(auth, id, {
        name: dto.name,
        hubLinkPolicy: dto.hubLinkPolicy,
      }),
    );
  }

  @ThrottleReauth()
  @Put(':id/recovery-key')
  @HttpCode(204)
  async doSetRecoveryKey(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: SetRecoveryKeyDto,
  ): Promise<void> {
    await this.setRecoveryKey.execute(auth, id, {
      recoveryPublicKey: dto.recoveryPublicKey,
      currentAuthProof: dto.currentAuthProof,
    });
  }
}
