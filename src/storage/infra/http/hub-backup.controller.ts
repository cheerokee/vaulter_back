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
  CurrentHub,
  HubAuth,
  type HubAuthContext,
} from '../../../shared/infra/http/hub-auth.decorators.js';
import { hubIdTracker } from '../../../shared/infra/http/hub-id.tracker.js';
import { RATE_LIMITS } from '../../../shared/infra/http/rate-limits.js';
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

// Backup com o token do PRÓPRIO Hub (spec storage-backup §4.2–4.3): enviar e apagar só nos espaços da Sala dele com
// `space_editor` (`memory.write`); listar e baixar com qualquer papel de Sala (`memory.read`; é assim que um Hub
// reinstalado restaura); qualquer outro caso é 404 `space-not-found`. Rotas
// internas (sem a tag `public`), limites por Hub (`hubIdTracker`: o HubTokenGuard roda antes do throttler).
@ApiTags('storage')
@Controller('hub/spaces/:spaceId')
export class HubBackupController {
  constructor(
    private readonly request: RequestUploadsUseCase,
    private readonly confirm: ConfirmUploadsUseCase,
    private readonly remove: DeleteObjectsUseCase,
    private readonly list: ListObjectsUseCase,
    private readonly download: GetDownloadUrlUseCase,
  ) {}

  /** Upload intent: up to 100 objects, all or nothing; presigned PUTs (15 min) to the provisional prefix. */
  @Throttle({
    default: { ...RATE_LIMITS.backupUploads, getTracker: hubIdTracker },
  })
  @ApiBearerAuth()
  @HubAuth()
  @Post('uploads')
  async doRequest(
    @CurrentHub() hub: HubAuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Body() dto: UploadIntentDto,
  ) {
    const items = await this.request.execute(
      { hubId: hub.hubId },
      spaceId,
      dto.items,
    );
    return { items: items.map(uploadIntentResponse) };
  }

  /** Confirms uploads (HEAD + server-side copy), all or nothing, idempotent. */
  @Throttle({
    default: { ...RATE_LIMITS.backupConfirm, getTracker: hubIdTracker },
  })
  @ApiBearerAuth()
  @HubAuth()
  @HttpCode(200)
  @Post('uploads/confirm')
  async doConfirm(
    @CurrentHub() hub: HubAuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Body() dto: ConfirmUploadsDto,
  ) {
    const items = await this.confirm.execute(
      { hubId: hub.hubId },
      spaceId,
      dto.uploadIds,
    );
    return { items: items.map(committedVersionResponse) };
  }

  /** Deletes objects (needs memory.write, like replacing: a Room `space_editor`; anything else is 404). */
  @Throttle({
    default: { ...RATE_LIMITS.backupDelete, getTracker: hubIdTracker },
  })
  @ApiBearerAuth()
  @HubAuth()
  @HttpCode(204)
  @Post('objects/delete')
  async doDelete(
    @CurrentHub() hub: HubAuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Body() dto: DeleteObjectsDto,
  ): Promise<void> {
    await this.remove.execute({ hubId: hub.hubId }, spaceId, dto.items);
  }

  /**
   * The index (no S3 call): `include=current` (default; with `since`, what changed, tombstones included), `trash`
   * (deleted in the last 30 days, with the last version) or `versions&objectId=` (stored versions of one object).
   */
  @Throttle({
    default: { ...RATE_LIMITS.backupList, getTracker: hubIdTracker },
  })
  @ApiBearerAuth()
  @HubAuth()
  @Get('objects')
  async doList(
    @CurrentHub() hub: HubAuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Query() query: ListObjectsQueryDto,
  ) {
    const result = await this.list.execute({ hubId: hub.hubId }, spaceId, {
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
    default: { ...RATE_LIMITS.backupDownload, getTracker: hubIdTracker },
  })
  @ApiBearerAuth()
  @HubAuth()
  @HttpCode(200)
  @Post('objects/:objectId/versions/:versionId/download')
  async doDownload(
    @CurrentHub() hub: HubAuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Param('objectId', uuidPipe('objectId')) objectId: string,
    @Param('versionId', uuidPipe('versionId')) versionId: string,
  ) {
    return downloadUrlResponse(
      await this.download.execute(
        { hubId: hub.hubId },
        spaceId,
        objectId,
        versionId,
      ),
    );
  }
}
