import { Injectable } from '@nestjs/common';
import { HubConversationScope } from '../../conversations/application/hub-conversation-scope.js';
import { HubDirectory } from '../../hubs/application/hub-directory.js';
import { ConflictError } from '../../shared/domain/errors.js';
import type { HubAuthContext } from '../../shared/application/hub-auth-context.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import {
  type AgentActionItem,
  dedupeAgentActions,
  newAgentActions,
} from '../domain/agent-action.js';
import { AgentActionRepository } from '../domain/agent-action.repository.js';
import { pcHubNotFound } from './pc-hub.js';

// `POST /hub/agent/actions` (token of a `pc` hub; spec pc-agent §5.6): the agent reports what it did with each tool, up
// to 100 items. The item carries ids, the tool name, the ACL effect, the decision, time, duration and policy version,
// never arguments, results, paths or URLs (the DTO refuses any other field). The organization and the space are NOT
// sent: the server reads them from the conversation, through the `conversations` port (`HubConversationScope`: the Hub
// must be the executor and linked to the organization). `owner_user_id` is the hub's owner, read here.
// All or nothing, one `uow.run`: a conversation the hub does not execute (or that does not exist) makes the WHOLE batch
// 404 `conversation-not-found` and nothing is written; the same id with identical content (before or inside the
// batch) is a no-op, with different content 409 `agent-action-id-conflict` (nothing written either).
// Returns how many rows this call wrote.
@Injectable()
export class RecordAgentActionsUseCase {
  constructor(
    private readonly hubs: HubDirectory,
    private readonly scope: HubConversationScope,
    private readonly actions: AgentActionRepository,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(
    hub: HubAuthContext,
    items: readonly AgentActionItem[],
  ): Promise<{ recorded: number }> {
    const unique = dedupeAgentActions(items);
    const ownerUserId = await this.hubs.ownerOf(hub.hubId);
    if (!ownerUserId) throw pcHubNotFound();
    return this.uow.run(async () => {
      await this.uow.setContext({ hubId: hub.hubId });
      // Every conversation first (404 for the whole batch before any write), in id order, one at a time.
      const origins = new Map<
        string,
        { organizationId: string; spaceId: string }
      >();
      for (const conversationId of [
        ...new Set(unique.map((i) => i.conversationId)),
      ].sort()) {
        origins.set(
          conversationId,
          await this.scope.organizationOf(hub.hubId, conversationId),
        );
      }
      const byOrganization = new Map<
        string,
        { item: AgentActionItem; spaceId: string }[]
      >();
      for (const item of unique) {
        const { organizationId, spaceId } = origins.get(item.conversationId)!;
        const rows = byOrganization.get(organizationId) ?? [];
        rows.push({ item, spaceId });
        byOrganization.set(organizationId, rows);
      }
      let recorded = 0;
      for (const organizationId of [...byOrganization.keys()].sort()) {
        const rows = byOrganization.get(organizationId)!;
        const known = await this.actions.findByIds(
          organizationId,
          hub.hubId,
          rows.map((r) => r.item.id),
        );
        const fresh = new Set(
          newAgentActions(
            rows.map((r) => r.item),
            known,
          ).map((i) => i.id),
        );
        const toWrite = rows.filter((r) => fresh.has(r.item.id));
        const written = await this.actions.insertMany({
          organizationId,
          hubId: hub.hubId,
          ownerUserId,
          rows: toWrite,
        });
        recorded += written.length;
        if (written.length < toWrite.length) {
          // Lost a race with the same batch (identical: fine) or the id already exists for this hub in another
          // organization (never identical: the conversation differs). Re-read and decide.
          const done = new Set(written);
          const rest = toWrite.filter((r) => !done.has(r.item.id));
          const nowKnown = await this.actions.findByIds(
            organizationId,
            hub.hubId,
            rest.map((r) => r.item.id),
          );
          if (
            newAgentActions(
              rest.map((r) => r.item),
              nowKnown,
            ).length > 0
          ) {
            throw new ConflictError(
              'agent-action-id-conflict',
              'An action with this id was already recorded with different content.',
            );
          }
        }
      }
      return { recorded };
    });
  }
}
