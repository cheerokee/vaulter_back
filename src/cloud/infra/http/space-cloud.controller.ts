import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  type AuthContext,
  CurrentAuth,
} from '../../../shared/infra/http/auth.decorators.js';
import { RATE_LIMITS } from '../../../shared/infra/http/rate-limits.js';
import { userIdTracker } from '../../../shared/infra/http/user-id.tracker.js';
import { uuidPipe } from '../../../shared/infra/http/uuid-pipe.js';
import {
  ActivateSpaceCloudUseCase,
  AuthorizeSpaceCloudUseCase,
  DeactivateSpaceCloudUseCase,
  GetSpaceCloudUseCase,
} from '../../application/space-cloud.use-cases.js';
import { ActivateSpaceCloudDto, spaceCloudResponse } from './dto/cloud.dto.js';

const perUser = () =>
  Throttle({
    default: { ...RATE_LIMITS.cloudSpaceChange, getTracker: userIdTracker },
  });

// Ligar/desligar a nuvem ativa de um espaço, em dois passos (spec active-cloud §4.1): quem decide autoriza, o Gestor
// manda a cópia da chave e liga. Rotas internas (tag `cloud`).
@ApiTags('cloud')
@Controller('spaces/:spaceId/cloud')
export class SpaceCloudController {
  constructor(
    private readonly getState: GetSpaceCloudUseCase,
    private readonly authorize: AuthorizeSpaceCloudUseCase,
    private readonly activate: ActivateSpaceCloudUseCase,
    private readonly deactivate: DeactivateSpaceCloudUseCase,
  ) {}

  /** The live cycle (`off` | `authorized` | `active`): any member of the space or whoever decides. */
  @ApiBearerAuth()
  @Get()
  async doGet(
    @CurrentAuth() auth: AuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
  ) {
    return spaceCloudResponse(await this.getState.execute(auth, spaceId));
  }

  /** Step 1, whoever decides (needs the current term accepted). Idempotent: an authorized/active space is returned. */
  @perUser()
  @ApiBearerAuth()
  @Post('authorize')
  @HttpCode(200)
  async doAuthorize(
    @CurrentAuth() auth: AuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
  ) {
    return spaceCloudResponse(await this.authorize.execute(auth, spaceId));
  }

  /** Step 2, the space manager: every key version sealed for the server key; the space becomes `active_cloud`. */
  @perUser()
  @ApiBearerAuth()
  @Post('activate')
  @HttpCode(200)
  async doActivate(
    @CurrentAuth() auth: AuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Body() dto: ActivateSpaceCloudDto,
  ) {
    return spaceCloudResponse(
      await this.activate.execute(auth, spaceId, {
        serverGrants: dto.serverGrants.map((g) => ({
          version: g.version,
          wrappedKey: g.wrappedKey,
        })),
      }),
    );
  }

  /** Whoever decides or the space manager: deletes the server's copies (and legible data) for real. 204. */
  @perUser()
  @ApiBearerAuth()
  @Post('deactivate')
  @HttpCode(204)
  async doDeactivate(
    @CurrentAuth() auth: AuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
  ): Promise<void> {
    await this.deactivate.execute(auth, spaceId);
  }
}
