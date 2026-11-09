import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { DataSource } from 'typeorm';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import { BackupObject } from '../../domain/backup-object.js';
import { BackupObjectRepository } from '../../domain/backup-object.repository.js';

type ObjectRow = {
  id: string;
  organization_id: string;
  space_id: string;
  current_version_id: string | null;
  deleted_at: Date | null;
};

const COLUMNS = `id, organization_id, space_id, current_version_id, deleted_at`;

function toDomain(row: ObjectRow): BackupObject {
  return BackupObject.restore({
    id: row.id,
    organizationId: row.organization_id,
    spaceId: row.space_id,
    currentVersionId: row.current_version_id,
    deletedAt: row.deleted_at,
  });
}

// Objetos do backup (storage_objects), em SQL: as travas e o "cria se não existe" precisam ver as lápides. Cada
// operação no escopo da organização (RLS; dentro de um UnitOfWork.run entra num savepoint, e o FOR UPDATE vale até
// o fim da transação de fora).
@Injectable()
export class BackupObjectTypeormRepository extends BackupObjectRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async lockOrCreate(
    orgId: string,
    spaceId: string,
    objectId: string,
  ): Promise<BackupObject | null> {
    if (!validate(objectId)) return null;
    return runInOrganizationScope(this.dataSource, orgId, async (m) => {
      // O id é global: se já existe em outro espaço ou em outra organização (invisível pelo RLS), o INSERT não faz
      // nada e a leitura abaixo não acha a linha deste espaço — o caso de uso responde 409, nunca 500.
      await m.query(
        `INSERT INTO storage_objects (id, organization_id, space_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
        [objectId, orgId, spaceId],
      );
      const rows: ObjectRow[] = await m.query(
        `SELECT ${COLUMNS} FROM storage_objects
          WHERE id = $1 AND organization_id = $2 AND space_id = $3 FOR UPDATE`,
        [objectId, orgId, spaceId],
      );
      return rows[0] ? toDomain(rows[0]) : null;
    });
  }

  async lockForUpdate(
    orgId: string,
    spaceId: string,
    objectId: string,
  ): Promise<BackupObject | null> {
    if (!validate(objectId)) return null;
    return runInOrganizationScope(this.dataSource, orgId, async (m) => {
      const rows: ObjectRow[] = await m.query(
        `SELECT ${COLUMNS} FROM storage_objects
          WHERE id = $1 AND organization_id = $2 AND space_id = $3 FOR UPDATE`,
        [objectId, orgId, spaceId],
      );
      return rows[0] ? toDomain(rows[0]) : null;
    });
  }

  async save(object: BackupObject): Promise<void> {
    await runInOrganizationScope(this.dataSource, object.organizationId, (m) =>
      m.query(
        // Relógio do banco NO MOMENTO da escrita (`clock_timestamp()`, não o início da transação): os casos de uso
        // gravam o objeto depois de todo o trabalho no S3, então `updated_at` (o `since` da listagem) fica a
        // milissegundos do COMMIT; a lápide usa o mesmo relógio da janela da lixeira.
        `UPDATE storage_objects
              SET current_version_id = $3,
                  deleted_at = CASE WHEN $4::boolean THEN COALESCE(deleted_at, clock_timestamp()) END,
                  updated_at = clock_timestamp()
            WHERE id = $1 AND organization_id = $2`,
        [
          object.id,
          object.organizationId,
          object.currentVersionId,
          object.deletedAt !== null,
        ],
      ),
    );
  }
}
