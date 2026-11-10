import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConversationAttachmentRepository } from './domain/conversation-attachment.repository.js';
import { ConversationKeyGrantRepository } from './domain/conversation-key-grant.repository.js';
import { ConversationMessageRepository } from './domain/conversation-message.repository.js';
import { ConversationParticipantRepository } from './domain/conversation-participant.repository.js';
import { ConversationRepository } from './domain/conversation.repository.js';
import { ConversationAttachmentTypeormEntity } from './infra/db/conversation-attachment.entity.js';
import { ConversationAttachmentTypeormRepository } from './infra/db/conversation-attachment.typeorm-repository.js';
import { ConversationKeyGrantTypeormEntity } from './infra/db/conversation-key-grant.entity.js';
import { ConversationKeyGrantTypeormRepository } from './infra/db/conversation-key-grant.typeorm-repository.js';
import { ConversationMessageTypeormEntity } from './infra/db/conversation-message.entity.js';
import { ConversationMessageTypeormRepository } from './infra/db/conversation-message.typeorm-repository.js';
import { ConversationParticipantTypeormEntity } from './infra/db/conversation-participant.entity.js';
import { ConversationParticipantTypeormRepository } from './infra/db/conversation-participant.typeorm-repository.js';
import { ConversationTypeormEntity } from './infra/db/conversation.entity.js';
import { ConversationTypeormRepository } from './infra/db/conversation.typeorm-repository.js';

/**
 * Conversations ("assuntos") as space data (spec 2026-11-09-conversations): encrypted with their own key, private to
 * their participants and executor Hub. Tables, row-level security and domain only for now (use cases and routes come
 * next). Exports nothing: no module imports `conversations`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ConversationTypeormEntity,
      ConversationParticipantTypeormEntity,
      ConversationKeyGrantTypeormEntity,
      ConversationMessageTypeormEntity,
      ConversationAttachmentTypeormEntity,
    ]),
  ],
  providers: [
    {
      provide: ConversationRepository,
      useClass: ConversationTypeormRepository,
    },
    {
      provide: ConversationParticipantRepository,
      useClass: ConversationParticipantTypeormRepository,
    },
    {
      provide: ConversationKeyGrantRepository,
      useClass: ConversationKeyGrantTypeormRepository,
    },
    {
      provide: ConversationMessageRepository,
      useClass: ConversationMessageTypeormRepository,
    },
    {
      provide: ConversationAttachmentRepository,
      useClass: ConversationAttachmentTypeormRepository,
    },
  ],
})
export class ConversationsModule {}
