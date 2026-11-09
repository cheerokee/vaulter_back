import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
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

// Backup com o token de uma PESSOA (o Hub em nome de quem está logado nele; qualquer sessão do membro vale, decisão
// da Task 5): enviar com `memory.write` (`space_editor`/`space_manager`), apagar com `memory.delete`
// (`space_manager`). `SpaceAccess`: 404 para não membro, 403 para membro sem a permissão. Mesmos casos de uso das
// rotas do Hub; limites por usuário.
@ApiTags('storage')
@Controller('spaces/:spaceId/backup')
export class SpaceBackupController {
  constructor(
    private readonly request: RequestUploadsUseCase,
    private readonly confirm: ConfirmUploadsUseCase,
    private readonly remove: DeleteObjectsUseCase,
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
}
