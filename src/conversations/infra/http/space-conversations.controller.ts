import {
  Body,
  Controller,
  Delete,
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
  type AuthContext,
  CurrentAuth,
} from '../../../shared/infra/http/auth.decorators.js';
import { RATE_LIMITS } from '../../../shared/infra/http/rate-limits.js';
import { ThrottleReauth } from '../../../shared/infra/http/throttling.decorators.js';
import { userIdTracker } from '../../../shared/infra/http/user-id.tracker.js';
import { uuidPipe } from '../../../shared/infra/http/uuid-pipe.js';
import { ChangeConversationStateUseCase } from '../../application/change-conversation-state.use-case.js';
import { ChangeExecutorUseCase } from '../../application/change-executor.use-case.js';
import { ConfirmAttachmentUseCase } from '../../application/confirm-attachment.use-case.js';
import { GetAttachmentDownloadUrlUseCase } from '../../application/get-attachment-download-url.use-case.js';
import { RequestAttachmentUploadUseCase } from '../../application/request-attachment-upload.use-case.js';
import { CreateConversationUseCase } from '../../application/create-conversation.use-case.js';
import { DeleteAttachmentUseCase } from '../../application/delete-attachment.use-case.js';
import { DeleteMessageUseCase } from '../../application/delete-message.use-case.js';
import { EmptyConversationTrashUseCase } from '../../application/empty-conversation-trash.use-case.js';
import { MoveConversationUseCase } from '../../application/move-conversation.use-case.js';
import { GetConversationUseCase } from '../../application/get-conversation.use-case.js';
import { LeaveConversationUseCase } from '../../application/leave-conversation.use-case.js';
import { RotateConversationKeyUseCase } from '../../application/rotate-conversation-key.use-case.js';
import { SendMessageUseCase } from '../../application/send-message.use-case.js';
import {
  ShareConversationUseCase,
  type ShareMode,
} from '../../application/share-conversation.use-case.js';
import {
  ChangeExecutorDto,
  CreateConversationDto,
  EmptyConversationTrashDto,
  MoveConversationDto,
  RequestAttachmentDto,
  RotateConversationKeyDto,
  SendMessageDto,
  ShareConversationDto,
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

const perUser = (limit: { limit: number; ttl: number }) =>
  Throttle({ default: { ...limit, getTracker: userIdTracker } });

// Assuntos com o token de usuário (spec conversations §4.1–4.2), todos sob o espaço: a organização vem do espaço.
// Quem não participa (ou não é membro do espaço, ou o assunto é de outro espaço): 404 `conversation-not-found`.
// Limites por usuário (`userIdTracker`), contador próprio por rota. Rotas internas (tag `conversations`).
@ApiTags('conversations')
@Controller('spaces/:spaceId/conversations')
export class SpaceConversationsController {
  constructor(
    private readonly create: CreateConversationUseCase,
    private readonly getOne: GetConversationUseCase,
    private readonly share: ShareConversationUseCase,
    private readonly leaving: LeaveConversationUseCase,
    private readonly state: ChangeConversationStateUseCase,
    private readonly executor: ChangeExecutorUseCase,
    private readonly rotate: RotateConversationKeyUseCase,
    private readonly sending: SendMessageUseCase,
    private readonly deleting: DeleteMessageUseCase,
    private readonly requestingUpload: RequestAttachmentUploadUseCase,
    private readonly confirming: ConfirmAttachmentUseCase,
    private readonly downloading: GetAttachmentDownloadUrlUseCase,
    private readonly deletingAttachment: DeleteAttachmentUseCase,
    private readonly moving: MoveConversationUseCase,
    private readonly emptyingTrash: EmptyConversationTrashUseCase,
  ) {}

  /** 201 when created; 200 with the same conversation when the same id is sent again (retry after a network error). */
  @perUser(RATE_LIMITS.conversationCreate)
  @ApiBearerAuth()
  @Post()
  async doCreate(
    @CurrentAuth() auth: AuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Body() dto: CreateConversationDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { view, created } = await this.create.execute(auth, spaceId, {
      id: dto.id,
      ...(dto.state ? { state: dto.state } : {}),
      encryptedHeader: dto.encryptedHeader,
      wrappedKey: dto.wrappedKey,
      executor: dto.executor
        ? { hubId: dto.executor.hubId, wrappedKey: dto.executor.wrappedKey }
        : null,
      movedFrom: dto.movedFrom
        ? {
            spaceId: dto.movedFrom.spaceId,
            conversationId: dto.movedFrom.conversationId,
          }
        : null,
    });
    res.status(created ? 201 : 200);
    return conversationResponse(view);
  }

  @ApiBearerAuth()
  @Get(':id')
  async doGet(
    @CurrentAuth() auth: AuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Param('id', uuidPipe('id')) id: string,
  ) {
    return conversationResponse(await this.getOne.byUser(auth, spaceId, id));
  }

  /** Any participant adds members of the space, sealing every version for each. */
  @perUser(RATE_LIMITS.conversationChange)
  @ApiBearerAuth()
  @Post(':id/participants')
  @HttpCode(200)
  async doShare(
    @CurrentAuth() auth: AuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: ShareConversationDto,
  ) {
    return this.doShareWith(auth, spaceId, id, dto, 'people');
  }

  /** "Share with the space": exactly the members who do not participate yet (409 `conversation-share-mismatch`). */
  @perUser(RATE_LIMITS.conversationChange)
  @ApiBearerAuth()
  @Post(':id/participants/space')
  @HttpCode(200)
  async doShareSpace(
    @CurrentAuth() auth: AuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: ShareConversationDto,
  ) {
    return this.doShareWith(auth, spaceId, id, dto, 'space');
  }

  /** Owner only (403 `not-conversation-owner`); removing oneself is leaving. */
  @perUser(RATE_LIMITS.conversationChange)
  @ApiBearerAuth()
  @Delete(':id/participants/:userId')
  @HttpCode(204)
  async doRemove(
    @CurrentAuth() auth: AuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Param('id', uuidPipe('id')) id: string,
    @Param('userId', uuidPipe('userId')) userId: string,
  ): Promise<void> {
    await this.leaving.remove(auth, spaceId, id, userId);
  }

  @perUser(RATE_LIMITS.conversationChange)
  @ApiBearerAuth()
  @Post(':id/leave')
  @HttpCode(204)
  async doLeave(
    @CurrentAuth() auth: AuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Param('id', uuidPipe('id')) id: string,
  ): Promise<void> {
    await this.leaving.leave(auth, spaceId, id);
  }

  /** The owner archives (`arquivado`) and reopens; work states belong to the executor (403 otherwise). */
  @perUser(RATE_LIMITS.conversationChange)
  @ApiBearerAuth()
  @Put(':id/state')
  async doState(
    @CurrentAuth() auth: AuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: StateDto,
  ) {
    return conversationResponse(
      await this.state.byUser(auth, spaceId, id, dto.state),
    );
  }

  /** Owner only: a new executor (every version sealed for it) or none; replacing one requires a key rotation. */
  @perUser(RATE_LIMITS.conversationChange)
  @ApiBearerAuth()
  @Put(':id/executor')
  async doExecutor(
    @CurrentAuth() auth: AuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: ChangeExecutorDto,
  ) {
    return conversationResponse(
      await this.executor.execute(auth, spaceId, id, {
        hubId: dto.hubId,
        grants: dto.grants.map((g) => ({
          keyVersion: g.keyVersion,
          wrappedKey: g.wrappedKey,
        })),
      }),
    );
  }

  /** New key version for exactly the live participants and the executor. */
  @perUser(RATE_LIMITS.conversationKeyRotation)
  @ApiBearerAuth()
  @Post(':id/keys')
  @HttpCode(200)
  async doRotate(
    @CurrentAuth() auth: AuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: RotateConversationKeyDto,
  ) {
    return conversationResponse(
      await this.rotate.byUser(auth, spaceId, id, rotationInput(dto)),
    );
  }

  /**
   * A message (born `pending` until the executor acknowledges it). 201 when created; 200 with the same answer when the
   * same id is sent again with the same content; 409 `message-id-conflict` for anything else with that id.
   */
  @perUser(RATE_LIMITS.conversationMessage)
  @ApiBearerAuth()
  @Post(':id/messages')
  async doSend(
    @CurrentAuth() auth: AuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: SendMessageDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { view, created } = await this.sending.byUser(
      auth,
      spaceId,
      id,
      messageInput(dto),
    );
    res.status(created ? 201 : 200);
    return messageResponse(view);
  }

  /** Only my own messages (403 `not-conversation-owner`); idempotent. */
  @perUser(RATE_LIMITS.conversationMessage)
  @ApiBearerAuth()
  @Delete(':id/messages/:messageId')
  @HttpCode(204)
  async doDeleteMessage(
    @CurrentAuth() auth: AuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Param('id', uuidPipe('id')) id: string,
    @Param('messageId', uuidPipe('messageId')) messageId: string,
  ): Promise<void> {
    await this.deleting.byUser(auth, spaceId, id, messageId);
  }

  /**
   * Upload intent of an encrypted attachment (≤ 100 MiB): reserves its size in the space and returns a presigned PUT.
   * 201; 200 for the same request again (a new URL, or `upload: null` when already committed).
   */
  @perUser(RATE_LIMITS.conversationAttachment)
  @ApiBearerAuth()
  @Post(':id/attachments')
  async doRequestAttachment(
    @CurrentAuth() auth: AuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: RequestAttachmentDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.requestingUpload.byUser(auth, spaceId, id, {
      id: dto.id,
      keyVersion: dto.keyVersion,
      sizeBytes: dto.sizeBytes,
      sha256: dto.sha256,
    });
    res.status(result.created ? 201 : 200);
    return attachmentUploadResponse(result);
  }

  /** HEAD + server-side copy of my own upload; idempotent. */
  @perUser(RATE_LIMITS.conversationAttachment)
  @ApiBearerAuth()
  @Post(':id/attachments/:attachmentId/confirm')
  @HttpCode(200)
  async doConfirmAttachment(
    @CurrentAuth() auth: AuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Param('id', uuidPipe('id')) id: string,
    @Param('attachmentId', uuidPipe('attachmentId')) attachmentId: string,
  ) {
    return attachmentResponse(
      await this.confirming.byUser(auth, spaceId, id, attachmentId),
    );
  }

  /** Presigned GET (15 min) of a committed attachment, by the S3 version recorded in the index. */
  @ApiBearerAuth()
  @Post(':id/attachments/:attachmentId/download')
  @HttpCode(200)
  async doDownloadAttachment(
    @CurrentAuth() auth: AuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Param('id', uuidPipe('id')) id: string,
    @Param('attachmentId', uuidPipe('attachmentId')) attachmentId: string,
  ) {
    return downloadUrlResponse(
      await this.downloading.byUser(auth, spaceId, id, attachmentId),
    );
  }

  /** Only my own attachments (403 `not-conversation-owner`); idempotent. It goes to the trash (30 days). */
  @perUser(RATE_LIMITS.conversationAttachment)
  @ApiBearerAuth()
  @Delete(':id/attachments/:attachmentId')
  @HttpCode(204)
  async doDeleteAttachment(
    @CurrentAuth() auth: AuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Param('id', uuidPipe('id')) id: string,
    @Param('attachmentId', uuidPipe('attachmentId')) attachmentId: string,
  ): Promise<void> {
    await this.deletingAttachment.byUser(auth, spaceId, id, attachmentId);
  }

  /**
   * Completes a move (owner only): tombstones this conversation once the one created in the other space with
   * `movedFrom` = this one exists. Idempotent (204 again).
   */
  @perUser(RATE_LIMITS.conversationChange)
  @ApiBearerAuth()
  @Post(':id/move')
  @HttpCode(204)
  async doMove(
    @CurrentAuth() auth: AuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: MoveConversationDto,
  ): Promise<void> {
    await this.moving.execute(auth, spaceId, id, {
      toSpaceId: dto.toSpaceId,
      toConversationId: dto.toConversationId,
    });
  }

  /**
   * The owner empties the trash of this conversation for good (deleted message bodies, and up to 1000 deleted
   * attachments per call: repeat while `remainingAttachments > 0`), with reauthentication.
   */
  @ThrottleReauth()
  @ApiBearerAuth()
  @Post(':id/trash/empty')
  @HttpCode(200)
  async doEmptyTrash(
    @CurrentAuth() auth: AuthContext,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: EmptyConversationTrashDto,
  ) {
    const r = await this.emptyingTrash.execute(
      auth,
      spaceId,
      id,
      dto.currentAuthProof,
    );
    return {
      purgedMessages: r.purgedMessages,
      purgedAttachments: r.purgedAttachments,
      purgedBytes: r.purgedBytes,
      remainingAttachments: r.remainingAttachments,
    };
  }

  private async doShareWith(
    auth: AuthContext,
    spaceId: string,
    id: string,
    dto: ShareConversationDto,
    mode: ShareMode,
  ) {
    return conversationResponse(
      await this.share.execute(
        auth,
        spaceId,
        id,
        dto.participants.map((p) => ({
          userId: p.userId,
          grants: p.grants.map((g) => ({
            keyVersion: g.keyVersion,
            wrappedKey: g.wrappedKey,
          })),
        })),
        mode,
      ),
    );
  }
}
