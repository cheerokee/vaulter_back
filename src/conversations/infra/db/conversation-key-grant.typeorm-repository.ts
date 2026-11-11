import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type {
  ActorRef,
  ConversationScope,
} from '../../domain/conversation-actor.js';
import {
  ConversationKeyGrantRepository,
  type ConversationKeyGrant,
} from '../../domain/conversation-key-grant.repository.js';
import { inScope, updatedRows } from './conversation-scope.js';

// Destinatário: coluna fixa (nunca vinda de entrada), para interpolar no SQL, e o valor gravado nela (o id da pessoa ou
// do Hub; `true` em `server_recipient` para a chave do servidor).
const column = (r: ActorRef) =>
  r.kind === 'user'
    ? 'user_id'
    : r.kind === 'hub'
      ? 'hub_id'
      : 'server_recipient';
const value = (r: ActorRef): string | boolean =>
  r.kind === 'user' ? r.userId : r.kind === 'hub' ? r.hubId : true;
// `<coluna> = $n`: para o servidor, `server_recipient = true`.
const matches = (r: ActorRef, n: number) => `${column(r)} = $${n}`;

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
    const r = grant.recipient;
    const col = column(r);
    const params = [
      scope.organizationId,
      conversationId,
      grant.keyVersion,
      value(r),
      grant.wrappedKey,
    ];
    // The arbiter is the recipient's partial unique index (the server's has no recipient column: one per version).
    const conflict =
      r.kind === 'cloud'
        ? `(conversation_id, key_version) WHERE server_recipient AND deleted_at IS NULL`
        : `(conversation_id, key_version, ${col}) WHERE ${col} IS NOT NULL AND deleted_at IS NULL`;
    await inScope(this.dataSource, scope, async (m) => {
      const revived = updatedRows(
        await m.query(
          `UPDATE conversation_key_grants
              SET wrapped_key = $5, deleted_at = NULL, updated_at = now()
            WHERE id = (
              SELECT id FROM conversation_key_grants
               WHERE organization_id = $1 AND conversation_id = $2 AND key_version = $3 AND ${matches(r, 4)}
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
         ON CONFLICT ${conflict}
         DO UPDATE SET wrapped_key = EXCLUDED.wrapped_key, updated_at = now()`,
        params,
      );
    });
  }

  async listFor(
    scope: ConversationScope,
    conversationId: string,
    recipient: ActorRef,
  ): Promise<{ keyVersion: number; wrappedKey: string }[]> {
    const rows: { key_version: number; wrapped_key: string }[] = await inScope(
      this.dataSource,
      scope,
      (m) =>
        m.query(
          `SELECT key_version, wrapped_key FROM conversation_key_grants
            WHERE organization_id = $1 AND conversation_id = $2 AND ${matches(recipient, 3)}
              AND deleted_at IS NULL
            ORDER BY key_version`,
          [scope.organizationId, conversationId, value(recipient)],
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
    recipient: Exclude<ActorRef, { kind: 'cloud' }>,
  ): Promise<number> {
    const raw: unknown = await inScope(this.dataSource, scope, (m) =>
      m.query(
        `UPDATE conversation_key_grants
            SET deleted_at = now(), updated_at = now()
          WHERE organization_id = $1 AND conversation_id = $2 AND ${matches(recipient, 3)}
            AND deleted_at IS NULL
          RETURNING id`,
        [scope.organizationId, conversationId, value(recipient)],
      ),
    );
    return updatedRows(raw).length;
  }

  async deleteServerCopies(
    scope: ConversationScope,
    conversationId: string,
  ): Promise<number> {
    const raw: unknown = await inScope(this.dataSource, scope, (m) =>
      m.query(
        `DELETE FROM conversation_key_grants
          WHERE organization_id = $1 AND conversation_id = $2 AND server_recipient
          RETURNING id`,
        [scope.organizationId, conversationId],
      ),
    );
    return updatedRows(raw).length;
  }
}
