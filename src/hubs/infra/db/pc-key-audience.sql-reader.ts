import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { DataSource } from 'typeorm';
import { runWithContext } from '../../../shared/infra/db/unit-of-work.js';
import {
  PcKeyAudience,
  type HubKeyView,
} from '../../application/ports/pc-key-audience.js';

// Quem, sem ser dono, pode ler a chave pública de um Hub `pc` (o `GET /hubs/:id` reduzido; spec pc-agent §5.1, §9).
// MESMA EXCEÇÃO DELIBERADA do `HubSyncSqlReader`: leitura só de leitura, em SQL cru, sobre `role_assignments`, `spaces`
// e `conversations` de outros módulos (os e2e de hub-kind cobrem as colunas lidas). Leitura confiável do backend, a
// autorização está no SQL:
// 1. contexto do Hub (`app.hub_id`, com `app.user_id`/`app.organization_id` em branco): a linha do Hub e os vínculos
//    aprovados e vivos dele;
// 2. para cada organização aprovada, EM SEQUÊNCIA, `{ organizationId, hubId }`: a pessoa é membro vivo de um espaço vivo
//    em que o Hub tem Sala viva, ou participante vivo de um assunto vivo de que o Hub é executor.
@Injectable()
export class PcKeyAudienceSqlReader extends PcKeyAudience {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async findKeyView(hubId: string, userId: string): Promise<HubKeyView | null> {
    if (!validate(hubId) || !validate(userId)) return null;
    return runWithContext(
      this.dataSource,
      { hubId, userId: '', organizationId: '' },
      async (m) => {
        const hubs: {
          id: string;
          name: string;
          kind: 'pc';
          encryption_public_key: string;
        }[] = await m.query(
          `SELECT id, name, kind, encryption_public_key FROM hubs
            WHERE id = $1 AND kind = 'pc' AND deleted_at IS NULL AND owner_user_id <> $2`,
          [hubId, userId],
        );
        const hub = hubs[0];
        if (!hub) return null;
        const orgs: { organization_id: string }[] = await m.query(
          `SELECT organization_id FROM hub_organization
            WHERE hub_id = $1 AND status = 'approved' AND deleted_at IS NULL
            ORDER BY organization_id`,
          [hubId],
        );
        for (const { organization_id: organizationId } of orgs) {
          const reached = await runWithContext(
            this.dataSource,
            { organizationId, hubId },
            async (om) => {
              const rows: { ok: boolean }[] = await om.query(
                `SELECT EXISTS (
                          SELECT 1 FROM role_assignments room
                            JOIN spaces s ON s.id = room.space_id AND s.organization_id = room.organization_id
                            JOIN role_assignments person
                              ON person.organization_id = room.organization_id AND person.space_id = room.space_id
                             AND person.scope_type = 'space' AND person.user_id = $2 AND person.deleted_at IS NULL
                           WHERE room.organization_id = $3 AND room.scope_type = 'space'
                             AND room.room_hub_id = $1 AND room.deleted_at IS NULL AND s.deleted_at IS NULL)
                     OR EXISTS (
                          SELECT 1 FROM conversations c
                           WHERE c.organization_id = $3 AND c.executor_hub_id = $1 AND c.deleted_at IS NULL
                             AND $2::uuid = ANY (c.participant_user_ids)) AS ok`,
                [hubId, userId, organizationId],
              );
              return rows[0]?.ok === true;
            },
          );
          if (reached) {
            return {
              id: hub.id,
              name: hub.name,
              kind: hub.kind,
              encryptionPublicKey: hub.encryption_public_key,
            };
          }
        }
        return null;
      },
    );
  }
}
