import {
  Body,
  Controller,
  Get,
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
import { pageResponse } from '../../../shared/infra/http/cursor-pagination.query.js';
import { uuidPipe } from '../../../shared/infra/http/uuid-pipe.js';
import { CreateSpaceUseCase } from '../../application/create-space.use-case.js';
import { GetSpaceUseCase } from '../../application/get-space.use-case.js';
import { ListSpacesUseCase } from '../../application/list-spaces.use-case.js';
import { RenameSpaceUseCase } from '../../application/rename-space.use-case.js';
import { ResizeSpaceStorageUseCase } from '../../application/resize-space-storage.use-case.js';
import {
  CreateSpaceDto,
  ListSpacesQuery,
  RenameSpaceDto,
  ResizeSpaceStorageDto,
} from './dto/space.dto.js';
import {
  spaceListItemResponse,
  spaceResponse,
  spaceSummaryResponse,
} from './dto/responses.js';

// Rotas internas do app (sem a tag `public`): nunca entram no Swagger dos integradores.
@ApiTags('spaces')
@Controller()
export class SpacesController {
  constructor(
    private readonly list: ListSpacesUseCase,
    private readonly create: CreateSpaceUseCase,
    private readonly get: GetSpaceUseCase,
    private readonly rename: RenameSpaceUseCase,
    private readonly resize: ResizeSpaceStorageUseCase,
  ) {}

  @ApiBearerAuth()
  @Get('organizations/:orgId/spaces')
  async doList(
    @CurrentAuth() auth: AuthContext,
    @Param('orgId', uuidPipe('orgId')) orgId: string,
    @Query() query: ListSpacesQuery,
  ) {
    const page = { cursor: query.cursor, limit: query.limit };
    if (query.all === 'true') {
      return pageResponse(
        await this.list.execute(auth, orgId, { all: true, page }),
        spaceSummaryResponse,
      );
    }
    return pageResponse(
      await this.list.execute(auth, orgId, { all: false, page }),
      spaceListItemResponse,
    );
  }

  @ApiBearerAuth()
  @Post('organizations/:orgId/spaces')
  async doCreate(
    @CurrentAuth() auth: AuthContext,
    @Param('orgId', uuidPipe('orgId')) orgId: string,
    @Body() dto: CreateSpaceDto,
  ) {
    return spaceResponse(
      await this.create.execute(auth, orgId, {
        name: dto.name,
        wrappedKey: dto.wrappedKey,
        recoveryPublicKey: dto.recoveryPublicKey,
        recoveryWrappedKey: dto.recoveryWrappedKey,
        ...(dto.storageQuotaBytes !== undefined
          ? { storageQuotaBytes: dto.storageQuotaBytes }
          : {}),
      }),
    );
  }

  @ApiBearerAuth()
  @Get('spaces/:id')
  async doGet(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
  ) {
    return spaceResponse(await this.get.execute(auth, id));
  }

  @ApiBearerAuth()
  @Patch('spaces/:id')
  async doRename(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: RenameSpaceDto,
  ) {
    return spaceResponse(
      await this.rename.execute(auth, id, { name: dto.name }),
    );
  }

  /** Space manager. Growing must fit the organization quota and every hub the space is on; shrinking, the usage. */
  @ApiBearerAuth()
  @Put('spaces/:id/storage-quota')
  async doResize(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: ResizeSpaceStorageDto,
  ) {
    return spaceResponse(
      await this.resize.execute(auth, id, {
        storageQuotaBytes: dto.storageQuotaBytes,
      }),
    );
  }
}
