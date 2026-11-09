import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
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
import { RequestUploadsUseCase } from '../../application/request-uploads.use-case.js';
import {
  ConfirmUploadsDto,
  DeleteObjectsDto,
  UploadIntentDto,
} from './dto/backup.dto.js';
import {
  committedVersionResponse,
  uploadIntentResponse,
} from './dto/responses.js';

// Backup com o token do PRÓPRIO Hub (spec storage-backup §4.2): só nos espaços da Sala dele com `space_editor`;
// qualquer outro caso é 404 `space-not-found`. Apagar exige `memory.delete`, que Sala nenhuma tem (404). Rotas
// internas (sem a tag `public`), limites por Hub (`hubIdTracker`: o HubTokenGuard roda antes do throttler).
@ApiTags('storage')
@Controller('hub/spaces/:spaceId')
export class HubBackupController {
  constructor(
    private readonly request: RequestUploadsUseCase,
    private readonly confirm: ConfirmUploadsUseCase,
    private readonly remove: DeleteObjectsUseCase,
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

  /** Deletes objects (needs memory.delete: never a Room, so always 404 here; kept for symmetry). */
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
}
