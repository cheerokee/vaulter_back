import { Injectable } from '@nestjs/common';
import { HubAccess } from '../../hubs/application/hub-access.js';
import { HubDirectory } from '../../hubs/application/hub-directory.js';
import type { Actor } from '../../identity/application/dto/actor.js';
import { OrganizationAccess } from '../../organizations/application/organization-access.js';
import { NotFoundError } from '../../shared/domain/errors.js';
import {
  type CursorPage,
  decodeCursor,
  pageFrom,
} from '../../shared/domain/pagination.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import {
  AgentActionRepository,
  type RecordedAgentAction,
} from '../domain/agent-action.repository.js';
import { requireOwnedPcHub } from './pc-hub.js';

// Reads of the action audit (spec pc-agent §5.6). Newest first by internal row id (UUID v7), cursor = the row id of the
// last item.
// - `GET /organizations/:orgId/agent-actions?userId=&hubId=&cursor=&limit=`: `org.agents.manage` (404 non-member, 403
//   without it), filters by the agent's owner and by hub. A session opened through a Hub (`actor.hubId`) is the same 404
//   as an outsider, before any read (an agent must not read its own audit; as the policy change does).
// - `GET /hubs/:id/agent/actions`: the owner of the `pc` hub only (404 `hub-not-found` for anyone else and for an
//   appliance), every organization the agent acted in.
@Injectable()
export class ListAgentActionsUseCase {
  constructor(
    private readonly orgAccess: OrganizationAccess,
    private readonly access: HubAccess,
    private readonly directory: HubDirectory,
    private readonly actions: AgentActionRepository,
    private readonly uow: UnitOfWork,
  ) {}

  ofOrganization(
    actor: Actor,
    organizationId: string,
    query: { userId?: string; hubId?: string; cursor?: string; limit: number },
  ): Promise<CursorPage<RecordedAgentAction>> {
    if (actor.hubId) {
      throw new NotFoundError(
        'organization-not-found',
        'The organization was not found.',
      );
    }
    return this.uow.withContext({ userId: actor.userId }, async () => {
      await this.orgAccess.requirePermission(
        organizationId,
        actor.userId,
        'org.agents.manage',
      );
      const after = query.cursor ? decodeCursor(query.cursor) : undefined;
      const rows = await this.actions.listOfOrganization(
        organizationId,
        { userId: query.userId, hubId: query.hubId },
        { after, limit: query.limit },
      );
      return pageFrom(rows, query.limit, (r) => r.rowId);
    });
  }

  ofHub(
    actor: Actor,
    hubId: string,
    query: { cursor?: string; limit: number },
  ): Promise<CursorPage<RecordedAgentAction>> {
    return this.uow.withContext({ userId: actor.userId }, async () => {
      await requireOwnedPcHub(this.access, this.directory, hubId, actor.userId);
      const after = query.cursor ? decodeCursor(query.cursor) : undefined;
      const rows = await this.actions.listOfHub(hubId, actor.userId, {
        after,
        limit: query.limit,
      });
      return pageFrom(rows, query.limit, (r) => r.rowId);
    });
  }
}
