import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
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
import { AckMessageUseCase } from '../../application/ack-message.use-case.js';
import { ConfirmAttachmentUseCase } from '../../application/confirm-attachment.use-case.js';
import { GetAttachmentDownloadUrlUseCase } from '../../application/get-attachment-download-url.use-case.js';
import { RequestAttachmentUploadUseCase } from '../../application/request-attachment-upload.use-case.js';
import { ChangeConversationStateUseCase } from '../../application/change-conversation-state.use-case.js';
import { DeleteMessageUseCase } from '../../application/delete-message.use-case.js';
import { GetConversationUseCase } from '../../application/get-conversation.use-case.js';
import { HubCreateConversationUseCase } from '../../application/hub-create-conversation.use-case.js';
import { RotateConversationKeyUseCase } from '../../application/rotate-conversation-key.use-case.js';
import { SendMessageUseCase } from '../../application/send-message.use-case.js';
import { SyncConversationsUseCase } from '../../application/sync-conversations.use-case.js';
import {
  HubConversationChangesQuery,
  conversationChangesResponse,
} from './dto/changes.dto.js';
import {
  HubCreateConversationDto,
  RequestAttachmentDto,
  RotateConversationKeyDto,
  SendMessageDto,
  StateDto,
  messageInput,
  rotationInput,
} from './dto/conversation.dto.js';
import {
  attachmentResponse,
  attachmentUploadResponse,
  conversationResponse,
  downloadUrlResponse,
  messageResponse,
} from './dto/responses.js';

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
    private readonly sending: SendMessageUseCase,
    private readonly acking: AckMessageUseCase,
    private readonly deleting: DeleteMessageUseCase,
    private readonly requestingUpload: RequestAttachmentUploadUseCase,
    private readonly confirming: ConfirmAttachmentUseCase,
    private readonly downloading: GetAttachmentDownloadUrlUseCase,
    private readonly sync: SyncConversationsUseCase,
  ) {}

  /**
   * The executor's feed (contract in `SyncConversationsUseCase`): the conversations where this hub is executor, in
   * organizations with an approved link. `wait` (0..25 s) holds the request while the page is empty, waking on a
   * change (LISTEN/NOTIFY) without holding a database connection. Declared BEFORE `:id` (Express matches in order).
   */
  @perHub(RATE_LIMITS.conversationHubChanges)
  @ApiBearerAuth()
  @HubAuth()
  @Get('changes')
  async doChanges(
    @CurrentHub() hub: HubAuthContext,
    @Query() query: HubConversationChangesQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    // The hub hung up: stop waiting (frees the long-poll slot); the response would go nowhere. The RESPONSE's `close`
    // (the request's fires as soon as its body is consumed, i.e. at once on a GET).
    const abort = new AbortController();
    const onClose = () => abort.abort();
    res.once('close', onClose);
    try {
      return conversationChangesResponse(
        await this.sync.byHub(
          { hubId: hub.hubId },
          {
            since: BigInt(query.since),
            limit: query.limit,
            conversationId: query.conversationId ?? null,
            waitSeconds: query.wait,
          },
          abort.signal,
        ),
      );
    } finally {
      res.off('close', onClose);
    }
  }

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

  /** The executor's message: born acknowledged. 201 / 200 (same id, same content) / 409 `message-id-conflict`. */
  @perHub(RATE_LIMITS.conversationHubMessage)
  @ApiBearerAuth()
  @HubAuth()
  @Post(':id/messages')
  async doSend(
    @CurrentHub() hub: HubAuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: SendMessageDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { view, created } = await this.sending.byHub(
      { hubId: hub.hubId },
      id,
      messageInput(dto),
    );
    res.status(created ? 201 : 200);
    return messageResponse(view);
  }

  /** Inbox: the executor took a person's message (the first ack wins; again = the same answer). */
  @perHub(RATE_LIMITS.conversationAck)
  @ApiBearerAuth()
  @HubAuth()
  @Post(':id/messages/:messageId/ack')
  @HttpCode(200)
  async doAck(
    @CurrentHub() hub: HubAuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Param('messageId', uuidPipe('messageId')) messageId: string,
  ) {
    return messageResponse(
      await this.acking.execute({ hubId: hub.hubId }, id, messageId),
    );
  }

  /** Only the hub's own messages (403 `not-conversation-owner`); idempotent. */
  @perHub(RATE_LIMITS.conversationHubMessage)
  @ApiBearerAuth()
  @HubAuth()
  @Delete(':id/messages/:messageId')
  @HttpCode(204)
  async doDeleteMessage(
    @CurrentHub() hub: HubAuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Param('messageId', uuidPipe('messageId')) messageId: string,
  ): Promise<void> {
    await this.deleting.byHub({ hubId: hub.hubId }, id, messageId);
  }

  /**
   * Upload intent of an encrypted attachment (≤ 100 MiB): reserves its size in the space and returns a presigned PUT.
   * 201; 200 for the same request again (a new URL, or `upload: null` when already committed).
   */
  @perHub(RATE_LIMITS.conversationHubAttachment)
  @ApiBearerAuth()
  @HubAuth()
  @Post(':id/attachments')
  async doRequestAttachment(
    @CurrentHub() hub: HubAuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: RequestAttachmentDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.requestingUpload.byHub({ hubId: hub.hubId }, id, {
      id: dto.id,
      keyVersion: dto.keyVersion,
      sizeBytes: dto.sizeBytes,
      sha256: dto.sha256,
    });
    res.status(result.created ? 201 : 200);
    return attachmentUploadResponse(result);
  }

  /** HEAD + server-side copy of the hub's own upload; idempotent. */
  @perHub(RATE_LIMITS.conversationHubAttachment)
  @ApiBearerAuth()
  @HubAuth()
  @Post(':id/attachments/:attachmentId/confirm')
  @HttpCode(200)
  async doConfirmAttachment(
    @CurrentHub() hub: HubAuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Param('attachmentId', uuidPipe('attachmentId')) attachmentId: string,
  ) {
    return attachmentResponse(
      await this.confirming.byHub({ hubId: hub.hubId }, id, attachmentId),
    );
  }

  /** Presigned GET (15 min) of a committed attachment, by the S3 version recorded in the index. */
  @ApiBearerAuth()
  @HubAuth()
  @Post(':id/attachments/:attachmentId/download')
  @HttpCode(200)
  async doDownloadAttachment(
    @CurrentHub() hub: HubAuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Param('attachmentId', uuidPipe('attachmentId')) attachmentId: string,
  ) {
    return downloadUrlResponse(
      await this.downloading.byHub({ hubId: hub.hubId }, id, attachmentId),
    );
  }
}
