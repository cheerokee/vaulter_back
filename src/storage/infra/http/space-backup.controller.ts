import {
  Body,
  Controller,
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
} from '../../../shared/infra/http/auth.decorators.js';
import { RATE_LIMITS } from '../../../shared/infra/http/rate-limits.js';
import { userIdTracker } from '../../../shared/infra/http/user-id.tracker.js';
import { uuidPipe } from '../../../shared/infra/http/uuid-pipe.js';
import { ConfirmUploadsUseCase } from '../../application/confirm-uploads.use-case.js';
import { DeleteObjectsUseCase } from '../../application/delete-objects.use-case.js';
import { GetDownloadUrlUseCase } from '../../application/get-download-url.use-case.js';
import { ListObjectsUseCase } from '../../application/list-objects.use-case.js';
import { RequestUploadsUseCase } from '../../application/request-uploads.use-case.js';
import {
  ConfirmUploadsDto,
  DeleteObjectsDto,
  ListObjectsQueryDto,
  UploadIntentDto,
} from './dto/backup.dto.js';
import {
  committedVersionResponse,
  downloadUrlResponse,
  objectListingResponse,
  uploadIntentResponse,
} from './dto/responses.js';

// Backup com o token de uma PESSOA (o Hub em nome de quem está logado nele; qualquer sessão do membro vale, decisão
// da Task 5): enviar com `memory.write` (`space_editor`/`space_manager`), apagar com `memory.delete`
// (`space_manager`), listar e baixar com `memory.read` (todo membro do espaço, inclusive num Hub fora da Sala). `SpaceAccess`: 404 para não membro, 403 para membro sem a permissão. Mesmos casos de uso das
// rotas do Hub; limites por usuário.
@ApiTags('storage')
@Controller('spaces/:spaceId/backup')
export class SpaceBackupController {
  constructor(
    private readonly request: RequestUploadsUseCase,
    private readonly confirm: ConfirmUploadsUseCase,
    private readonly remove: DeleteObjectsUseCase,
    private readonly list: ListObjectsUseCase,
    private readonly download: GetDownloadUrlUseCase,
  ) {}

  @Throttle({
    default: { ...RATE_LIMITS.backupUploads, getTracker: userIdTracker },
  })
  @ApiBearerAuth()
  @Post('uploads')
  async doRequest(
    @CurrentAuth() auth: AuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Body() dto: UploadIntentDto,
  ) {
    const items = await this.request.execute(
      { userId: auth.userId },
      spaceId,
      dto.items,
    );
    return { items: items.map(uploadIntentResponse) };
  }

  @Throttle({
    default: { ...RATE_LIMITS.backupConfirm, getTracker: userIdTracker },
  })
  @ApiBearerAuth()
  @HttpCode(200)
  @Post('uploads/confirm')
  async doConfirm(
    @CurrentAuth() auth: AuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Body() dto: ConfirmUploadsDto,
  ) {
    const items = await this.confirm.execute(
      { userId: auth.userId },
      spaceId,
      dto.uploadIds,
    );
    return { items: items.map(committedVersionResponse) };
  }

  @Throttle({
    default: { ...RATE_LIMITS.backupDelete, getTracker: userIdTracker },
  })
  @ApiBearerAuth()
  @HttpCode(204)
  @Post('objects/delete')
  async doDelete(
    @CurrentAuth() auth: AuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Body() dto: DeleteObjectsDto,
  ): Promise<void> {
    await this.remove.execute({ userId: auth.userId }, spaceId, dto.items);
  }

  /**
   * The index (no S3 call): `include=current` (default; with `since`, what changed, tombstones included), `trash`
   * (deleted in the last 30 days, with the last version) or `versions&objectId=` (stored versions of one object).
   */
  @Throttle({
    default: { ...RATE_LIMITS.backupList, getTracker: userIdTracker },
  })
  @ApiBearerAuth()
  @Get('objects')
  async doList(
    @CurrentAuth() auth: AuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Query() query: ListObjectsQueryDto,
  ) {
    const result = await this.list.execute({ userId: auth.userId }, spaceId, {
      include: query.include,
      ...(query.since ? { since: new Date(query.since) } : {}),
      ...(query.objectId ? { objectId: query.objectId } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });
    return objectListingResponse(result);
  }

  /** Presigned GET (15 min) of one version: live or in the 30-day trash (else 404 version-not-found). */
  @Throttle({
    default: { ...RATE_LIMITS.backupDownload, getTracker: userIdTracker },
  })
  @ApiBearerAuth()
  @HttpCode(200)
  @Post('objects/:objectId/versions/:versionId/download')
  async doDownload(
    @CurrentAuth() auth: AuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Param('objectId', uuidPipe('objectId')) objectId: string,
    @Param('versionId', uuidPipe('versionId')) versionId: string,
  ) {
    return downloadUrlResponse(
      await this.download.execute(
        { userId: auth.userId },
        spaceId,
        objectId,
        versionId,
      ),
    );
  }
}
