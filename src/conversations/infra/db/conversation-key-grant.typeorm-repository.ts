import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type {
  ConversationActor,
  ConversationScope,
} from '../../domain/conversation-actor.js';
import {
  ConversationKeyGrantRepository,
  type ConversationKeyGrant,
} from '../../domain/conversation-key-grant.repository.js';
import { inScope, updatedRows } from './conversation-scope.js';

// Coluna do destinatário: nome fixo (nunca vindo de entrada), para interpolar no SQL.
const recipientColumn = (r: ConversationActor) =>
  r.kind === 'user' ? 'user_id' : 'hub_id';
const recipientId = (r: ConversationActor) =>
  r.kind === 'user' ? r.userId : r.hubId;

@Injectable()
export class ConversationKeyGrantTypeormRepository extends ConversationKeyGrantRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  // Uma linha por (versão, destinatário) enquanto der: troca o valor da viva ou limpa a lápide da última; só insere
  // quando nunca houve. Na corrida de dois INSERTs, o segundo cai no ON CONFLICT do índice parcial e só atualiza.
  async put(
    scope: ConversationScope,
    conversationId: string,
    grant: ConversationKeyGrant,
  ): Promise<void> {
    const col = recipientColumn(grant.recipient);
    const params = [
      scope.organizationId,
      conversationId,
      grant.keyVersion,
      recipientId(grant.recipient),
      grant.wrappedKey,
    ];
    await inScope(this.dataSource, scope, async (m) => {
      const revived = updatedRows(
        await m.query(
          `UPDATE conversation_key_grants
              SET wrapped_key = $5, deleted_at = NULL, updated_at = now()
            WHERE id = (
              SELECT id FROM conversation_key_grants
               WHERE organization_id = $1 AND conversation_id = $2 AND key_version = $3 AND ${col} = $4
               ORDER BY (deleted_at IS NULL) DESC, deleted_at DESC, id DESC
               LIMIT 1)
           RETURNING id`,
          params,
        ),
      );
      if (revived.length > 0) return;
      await m.query(
        `INSERT INTO conversation_key_grants (organization_id, conversation_id, key_version, ${col}, wrapped_key)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (conversation_id, key_version, ${col}) WHERE ${col} IS NOT NULL AND deleted_at IS NULL
         DO UPDATE SET wrapped_key = EXCLUDED.wrapped_key, updated_at = now()`,
        params,
      );
    });
  }

  async listFor(
    scope: ConversationScope,
    conversationId: string,
    recipient: ConversationActor,
  ): Promise<{ keyVersion: number; wrappedKey: string }[]> {
    const rows: { key_version: number; wrapped_key: string }[] = await inScope(
      this.dataSource,
      scope,
      (m) =>
        m.query(
          `SELECT key_version, wrapped_key FROM conversation_key_grants
            WHERE organization_id = $1 AND conversation_id = $2 AND ${recipientColumn(recipient)} = $3
              AND deleted_at IS NULL
            ORDER BY key_version`,
          [scope.organizationId, conversationId, recipientId(recipient)],
        ),
    );
    return rows.map((r) => ({
      keyVersion: r.key_version,
      wrappedKey: r.wrapped_key,
    }));
  }

  async removeFor(
    scope: ConversationScope,
    conversationId: string,
    recipient: ConversationActor,
  ): Promise<number> {
    const raw: unknown = await inScope(this.dataSource, scope, (m) =>
      m.query(
        `UPDATE conversation_key_grants
            SET deleted_at = now(), updated_at = now()
          WHERE organization_id = $1 AND conversation_id = $2 AND ${recipientColumn(recipient)} = $3
            AND deleted_at IS NULL
          RETURNING id`,
        [scope.organizationId, conversationId, recipientId(recipient)],
      ),
    );
    return updatedRows(raw).length;
  }
}
