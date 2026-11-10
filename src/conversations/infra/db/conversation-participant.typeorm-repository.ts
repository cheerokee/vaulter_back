import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { ConversationScope } from '../../domain/conversation-actor.js';
import { conversationNotFound } from '../../domain/conversation-errors.js';
import { ConversationParticipantRepository } from '../../domain/conversation-participant.repository.js';
import type { LiveParticipant } from '../../domain/participation-rules.js';
import { inScope, updatedRows } from './conversation-scope.js';

@Injectable()
export class ConversationParticipantTypeormRepository extends ConversationParticipantRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  // Uma linha por (conversa, pessoa) enquanto der: reaproveita a última lápide (joined_at novo: quem volta entra no fim
  // da fila da sucessão do dono). Na corrida de dois INSERTs, o segundo cai no ON CONFLICT do índice parcial.
  async add(
    scope: ConversationScope,
    conversationId: string,
    userId: string,
    joinedAt: Date,
  ): Promise<void> {
    await inScope(this.dataSource, scope, async (m) => {
      const latest: { id: string; live: boolean }[] = await m.query(
        `SELECT id, deleted_at IS NULL AS live FROM conversation_participants
          WHERE organization_id = $1 AND conversation_id = $2 AND user_id = $3
          ORDER BY (deleted_at IS NULL) DESC, deleted_at DESC, id DESC
          LIMIT 1`,
        [scope.organizationId, conversationId, userId],
      );
      const row = latest[0];
      if (row?.live) return;
      if (row) {
        // A própria lápide é visível a quem saiu, mas o UPDATE exige a conversa visível: 0 linhas = sem acesso.
        const revived = updatedRows(
          await m.query(
            `UPDATE conversation_participants
                SET deleted_at = NULL, joined_at = $2, updated_at = now()
              WHERE id = $1 AND deleted_at IS NOT NULL
              RETURNING id`,
            [row.id, joinedAt],
          ),
        );
        if (revived.length === 0) throw conversationNotFound();
        return;
      }
      await m.query(
        `INSERT INTO conversation_participants (organization_id, conversation_id, user_id, joined_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (conversation_id, user_id) WHERE deleted_at IS NULL DO NOTHING`,
        [scope.organizationId, conversationId, userId, joinedAt],
      );
    });
  }

  async listLive(
    scope: ConversationScope,
    conversationId: string,
  ): Promise<LiveParticipant[]> {
    const rows: { user_id: string; joined_at: Date }[] = await inScope(
      this.dataSource,
      scope,
      (m) =>
        m.query(
          `SELECT user_id, joined_at FROM conversation_participants
            WHERE organization_id = $1 AND conversation_id = $2 AND deleted_at IS NULL
            ORDER BY joined_at, user_id`,
          [scope.organizationId, conversationId],
        ),
    );
    return rows.map((r) => ({ userId: r.user_id, joinedAt: r.joined_at }));
  }

  async remove(
    scope: ConversationScope,
    conversationId: string,
    userId: string,
  ): Promise<boolean> {
    const raw: unknown = await inScope(this.dataSource, scope, (m) =>
      m.query(
        `UPDATE conversation_participants
            SET deleted_at = now(), updated_at = now()
          WHERE organization_id = $1 AND conversation_id = $2 AND user_id = $3 AND deleted_at IS NULL
          RETURNING id`,
        [scope.organizationId, conversationId, userId],
      ),
    );
    return updatedRows(raw).length > 0;
  }
}
