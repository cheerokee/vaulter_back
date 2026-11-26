import { Injectable } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { validate } from 'uuid';
import { currentManager } from '../../../shared/infra/db/unit-of-work.js';
import type { AgentToolDef } from '../../domain/agent-tool.js';
import { AgentToolRepository } from '../../domain/agent-tool.repository.js';
import { AgentToolTypeormEntity } from './agent-tool.entity.js';

// Roda no contexto ambiente (`app.hub_id` do próprio Hub ou `app.user_id` do dono); o RLS decide o que é visível.
@Injectable()
export class AgentToolTypeormRepository extends AgentToolRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  private get manager() {
    return currentManager(this.dataSource);
  }

  async replaceAll(
    hubId: string,
    ownerUserId: string,
    tools: readonly AgentToolDef[],
  ): Promise<void> {
    const names = tools.map((t) => t.name);
    // Dois PUT concorrentes do mesmo Hub se serializam aqui, antes de tocar qualquer linha: sem isso a lápide (ordem da
    // varredura) e o upsert (ordem de nome) de um e do outro travariam linhas em ordens diferentes (deadlock). Advisory
    // de transação (some no COMMIT), chave (namespace, Hub); uma colisão de `hashtext` só serializa dois Hubs à toa.
    await this.manager.query(
      `SELECT pg_advisory_xact_lock(hashtext('agent-tools'), hashtext($1))`,
      [hubId],
    );
    // Lápide no que saiu (e que ainda estava vivo).
    await this.manager.query(
      `UPDATE agent_tools SET deleted_at = now(), updated_at = now()
        WHERE hub_id = $1 AND deleted_at IS NULL AND NOT (name = ANY($2::text[]))`,
      [hubId, names],
    );
    // Upsert do resto, em ordem de nome (um lote só, sem laço de ida e volta ao banco).
    for (const t of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
      await this.manager.query(
        `INSERT INTO agent_tools (hub_id, owner_user_id, name, title, description, input_schema, category)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT (hub_id, name) DO UPDATE
            SET title = EXCLUDED.title, description = EXCLUDED.description,
                input_schema = EXCLUDED.input_schema, category = EXCLUDED.category,
                deleted_at = NULL, updated_at = now()`,
        [
          hubId,
          ownerUserId,
          t.name,
          t.title,
          t.description,
          JSON.stringify(t.inputSchema),
          t.category,
        ],
      );
    }
  }

  async listOfHub(hubId: string): Promise<AgentToolDef[]> {
    if (!validate(hubId)) return [];
    const rows = await this.manager
      .getRepository(AgentToolTypeormEntity)
      .find({ where: { hubId, deletedAt: IsNull() }, order: { name: 'ASC' } });
    return rows.map((r) => ({
      name: r.name,
      title: r.title,
      description: r.description,
      inputSchema: r.inputSchema,
      category: r.category,
    }));
  }
}
