import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  type AuthContext,
  CurrentAuth,
} from '../../../shared/infra/http/auth.decorators.js';
import { RATE_LIMITS } from '../../../shared/infra/http/rate-limits.js';
import { userIdTracker } from '../../../shared/infra/http/user-id.tracker.js';
import { SyncConversationsUseCase } from '../../application/sync-conversations.use-case.js';
import {
  ConversationChangesQuery,
  conversationChangesResponse,
} from './dto/changes.dto.js';

// Feed de mudanças dos assuntos da PESSOA (spec conversations §4.6), em todas as organizações em que ela é membro
// ativo: fora de `/spaces/:spaceId` porque o app sincroniza tudo de uma vez (um cursor só). Contrato no comentário de
// `SyncConversationsUseCase`. Rota interna (tag `conversations`), limite por usuário.
@ApiTags('conversations')
@Controller('conversations')
export class ConversationChangesController {
  constructor(private readonly sync: SyncConversationsUseCase) {}

  @Throttle({
    default: { ...RATE_LIMITS.conversationChanges, getTracker: userIdTracker },
  })
  @ApiBearerAuth()
  @Get('changes')
  async doChanges(
    @CurrentAuth() auth: AuthContext,
    @Query() query: ConversationChangesQuery,
  ) {
    return conversationChangesResponse(
      await this.sync.byUser(auth, {
        since: BigInt(query.since),
        limit: query.limit,
        conversationId: query.conversationId ?? null,
      }),
    );
  }
}
