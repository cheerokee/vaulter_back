import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import {
  SpaceIntentRepository,
  type SpaceIntent,
} from '../../domain/space-intent.repository.js';
import { spaceFactoryRoleId } from './db-helpers.js';

// Só do backend. O convite é do organizations: aqui só a FK (o InvitationHooks passa o id do convite que a
// própria organização acabou de criar, no mesmo unit of work).
@Injectable()
export class SpaceIntentTypeormRepository extends SpaceIntentRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  // Cada espaço precisa ser da organização do contexto (organization_id vem dele).
  async record(
    orgId: string,
    invitationId: string,
    intents: readonly SpaceIntent[],
  ): Promise<void> {
    if (intents.length === 0) return;
    await runInOrganizationScope(this.dataSource, orgId, async (m) => {
      for (const intent of intents) {
        const roleId = await spaceFactoryRoleId(m, intent.roleKey);
        const rows: { id: string }[] = await m.query(
          `INSERT INTO invitation_space_intents (organization_id, invitation_id, space_id, role_id)
           SELECT s.organization_id, $2, s.id, $4
             FROM spaces s
            WHERE s.id = $3 AND s.organization_id = $1 AND s.deleted_at IS NULL
           RETURNING id`,
          [orgId, invitationId, intent.spaceId, roleId],
        );
        if (rows.length === 0) {
          throw new Error(
            'SpaceIntentRepository.record: the space does not exist in this organization.',
          );
        }
      }
    });
  }

  // Na ordem em que foram gravadas (id v7).
  async forInvitation(
    orgId: string,
    invitationId: string,
  ): Promise<SpaceIntent[]> {
    const rows: { space_id: string; role_key: SpaceIntent['roleKey'] }[] =
      await runInOrganizationScope(this.dataSource, orgId, (m) =>
        m.query(
          `SELECT i.space_id, r.key AS role_key
             FROM invitation_space_intents i JOIN roles r ON r.id = i.role_id
            WHERE i.organization_id = $1 AND i.invitation_id = $2 AND i.deleted_at IS NULL
            ORDER BY i.id ASC`,
          [orgId, invitationId],
        ),
      );
    return rows.map((r) => ({ spaceId: r.space_id, roleKey: r.role_key }));
  }
}
