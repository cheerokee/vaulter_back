import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  type AuthContext,
  CurrentAuth,
} from '../../../shared/infra/http/auth.decorators.js';
import { RATE_LIMITS } from '../../../shared/infra/http/rate-limits.js';
import { ThrottleReauth } from '../../../shared/infra/http/throttling.decorators.js';
import { userIdTracker } from '../../../shared/infra/http/user-id.tracker.js';
import { uuidPipe } from '../../../shared/infra/http/uuid-pipe.js';
import { GetMyKeysUseCase } from '../../application/get-my-keys.use-case.js';
import { GetRecoveryCopiesUseCase } from '../../application/get-recovery-copies.use-case.js';
import { RecoverOrphanSpaceUseCase } from '../../application/recover-orphan-space.use-case.js';
import { RewrapRecoveryUseCase } from '../../application/rewrap-recovery.use-case.js';
import { RotateSpaceKeyUseCase } from '../../application/rotate-space-key.use-case.js';
import {
  RecoverOrphanSpaceDto,
  RecoveryCopiesDto,
  RewrapRecoveryDto,
  RotateSpaceKeyDto,
} from './dto/key.dto.js';
import { myKeysResponse, recoveryCopiesResponse } from './dto/responses.js';

// Só cópias trancadas passam por aqui: o backend nunca vê a chave do espaço em claro.
@ApiTags('spaces')
@Controller('spaces/:id')
export class SpaceKeysController {
  constructor(
    private readonly myKeys: GetMyKeysUseCase,
    private readonly rotate: RotateSpaceKeyUseCase,
    private readonly rewrap: RewrapRecoveryUseCase,
    private readonly recover: RecoverOrphanSpaceUseCase,
    private readonly recoveryCopies: GetRecoveryCopiesUseCase,
  ) {}

  @ApiBearerAuth()
  @Get('keys')
  async doMyKeys(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
  ) {
    return myKeysResponse(await this.myKeys.execute(auth, id));
  }

  /** Per-user limit on its own counter (each rotation adds a version for good). */
  @Throttle({
    default: { ...RATE_LIMITS.spaceKeyRotation, getTracker: userIdTracker },
  })
  @ApiBearerAuth()
  @Post('keys')
  async doRotate(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: RotateSpaceKeyDto,
  ) {
    return this.rotate.execute(auth, id, {
      version: dto.version,
      recoveryPublicKey: dto.recoveryPublicKey,
      recoveryWrappedKey: dto.recoveryWrappedKey,
      grants: dto.grants.map((g) => ({
        userId: g.userId,
        wrappedKey: g.wrappedKey,
      })),
    });
  }

  @ApiBearerAuth()
  @Put('keys/recovery')
  async doRewrap(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: RewrapRecoveryDto,
  ) {
    return this.rewrap.execute(auth, id, {
      recoveryPublicKey: dto.recoveryPublicKey,
      versions: dto.versions.map((v) => ({
        version: v.version,
        wrappedKey: v.wrappedKey,
      })),
    });
  }

  /**
   * Org admin reads the kit copies of an orphan space (first step of the recovery: the app opens them with the
   * kit secret and seals them for the admin). POST because the body carries the reauthentication proof.
   */
  @ThrottleReauth()
  @ApiBearerAuth()
  @Post('recover/copies')
  @HttpCode(200)
  async doRecoveryCopies(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: RecoveryCopiesDto,
  ) {
    return recoveryCopiesResponse(
      await this.recoveryCopies.execute(auth, id, {
        currentAuthProof: dto.currentAuthProof,
      }),
    );
  }

  /** Org admin reopens an orphan space with the recovery kit (shares the per-user reauth budget). */
  @ThrottleReauth()
  @ApiBearerAuth()
  @Post('recover')
  @HttpCode(200)
  async doRecover(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: RecoverOrphanSpaceDto,
  ) {
    return this.recover.execute(auth, id, {
      grants: dto.grants.map((g) => ({
        version: g.version,
        wrappedKey: g.wrappedKey,
      })),
      currentAuthProof: dto.currentAuthProof,
    });
  }
}
