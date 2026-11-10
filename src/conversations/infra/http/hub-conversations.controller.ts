import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import {
  CurrentHub,
  HubAuth,
  type HubAuthContext,
} from '../../../shared/infra/http/hub-auth.decorators.js';
import { hubIdTracker } from '../../../shared/infra/http/hub-id.tracker.js';
import { RATE_LIMITS } from '../../../shared/infra/http/rate-limits.js';
import { uuidPipe } from '../../../shared/infra/http/uuid-pipe.js';
import { ChangeConversationStateUseCase } from '../../application/change-conversation-state.use-case.js';
import { GetConversationUseCase } from '../../application/get-conversation.use-case.js';
import { HubCreateConversationUseCase } from '../../application/hub-create-conversation.use-case.js';
import { RotateConversationKeyUseCase } from '../../application/rotate-conversation-key.use-case.js';
import {
  HubCreateConversationDto,
  RotateConversationKeyDto,
  StateDto,
  rotationInput,
} from './dto/conversation.dto.js';
import { conversationResponse } from './dto/responses.js';

const perHub = (limit: { limit: number; ttl: number }) =>
  Throttle({ default: { ...limit, getTracker: hubIdTracker } });

// Assuntos com o token do PRÓPRIO Hub (o executor, spec conversations §4.1–4.2): criar (o "aviso", em nome de uma
// pessoa), ler, mudar os estados de trabalho e trocar a chave pendente. Assunto de que o Hub não é executor: 404
// `conversation-not-found`. Limites por Hub (`hubIdTracker`: o HubTokenGuard roda antes do throttler).
@ApiTags('conversations')
@Controller('hub/conversations')
export class HubConversationsController {
  constructor(
    private readonly create: HubCreateConversationUseCase,
    private readonly getOne: GetConversationUseCase,
    private readonly state: ChangeConversationStateUseCase,
    private readonly rotate: RotateConversationKeyUseCase,
  ) {}

  /** 201 when created; 200 with the same conversation when the same id is sent again. */
  @perHub(RATE_LIMITS.conversationCreate)
  @ApiBearerAuth()
  @HubAuth()
  @Post()
  async doCreate(
    @CurrentHub() hub: HubAuthContext,
    @Body() dto: HubCreateConversationDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { view, created } = await this.create.execute(
      { hubId: hub.hubId },
      {
        id: dto.id,
        spaceId: dto.spaceId,
        ownerUserId: dto.ownerUserId,
        ...(dto.state ? { state: dto.state } : {}),
        encryptedHeader: dto.encryptedHeader,
        grants: dto.grants.map((g) => ({
          userId: g.userId,
          wrappedKey: g.wrappedKey,
        })),
        hubWrappedKey: dto.hubWrappedKey,
      },
    );
    res.status(created ? 201 : 200);
    return conversationResponse(view);
  }

  @ApiBearerAuth()
  @HubAuth()
  @Get(':id')
  async doGet(
    @CurrentHub() hub: HubAuthContext,
    @Param('id', uuidPipe('id')) id: string,
  ) {
    return conversationResponse(
      await this.getOne.byHub({ hubId: hub.hubId }, id),
    );
  }

  /** Work states (everything but archiving, which is the owner's: 403 `not-conversation-owner`). */
  @perHub(RATE_LIMITS.conversationChange)
  @ApiBearerAuth()
  @HubAuth()
  @Put(':id/state')
  async doState(
    @CurrentHub() hub: HubAuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: StateDto,
  ) {
    return conversationResponse(
      await this.state.byHub({ hubId: hub.hubId }, id, dto.state),
    );
  }

  /** A pending rotation: the new version for exactly the live participants and the hub itself. */
  @perHub(RATE_LIMITS.conversationKeyRotation)
  @ApiBearerAuth()
  @HubAuth()
  @Post(':id/keys')
  @HttpCode(200)
  async doRotate(
    @CurrentHub() hub: HubAuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: RotateConversationKeyDto,
  ) {
    return conversationResponse(
      await this.rotate.byHub({ hubId: hub.hubId }, id, rotationInput(dto)),
    );
  }
}
