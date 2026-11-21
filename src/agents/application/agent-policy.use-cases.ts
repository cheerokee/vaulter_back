import { Injectable } from '@nestjs/common';
import { HubDirectory } from '../../hubs/application/hub-directory.js';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { OrganizationAccess } from '../../organizations/application/organization-access.js';
import { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import { NotFoundError } from '../../shared/domain/errors.js';
import type { HubAuthContext } from '../../shared/application/hub-auth-context.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import {
  type AgentRule,
  parseAgentRules,
  rulesFor,
} from '../domain/agent-policy.js';
import { AgentPolicyRepository } from '../domain/agent-policy.repository.js';
import {
  type AgentPolicy,
  nextPolicyVersion,
} from '../domain/agent-policy-version.js';
import { AgentPolicyReader } from './agent-policy-reader.js';
import { pcHubNotFound } from './pc-hub.js';

export type AgentPolicyView = AgentPolicy & { organizationId: string };

// `GET /organizations/:orgId/agent-policy` (spec pc-agent §5.5): every member sees the whole policy of the
// organization (404 for a non-member), because the person should know what the AI may do on their PC.
@Injectable()
export class GetAgentPolicyUseCase {
  constructor(
    private readonly access: OrganizationAccess,
    private readonly reader: AgentPolicyReader,
  ) {}

  async execute(
    actor: Actor,
    organizationId: string,
  ): Promise<AgentPolicyView> {
    await this.access.requireMember(organizationId, actor.userId);
    return { organizationId, ...(await this.reader.current(organizationId)) };
  }
}

// `PUT /organizations/:orgId/agent-policy` `{ baseVersion, rules }`: replaces the whole policy with a new version.
// Order: format -> permission (`org.agents.manage`: 404 non-member, 403 without it) -> rules (422, with the indexes of
// all invalid ones) -> `uow.run`: organization row locked (leaf lock) -> `baseVersion` against the highest version
// (409 `agent-policy-version-stale`) -> insert `baseVersion + 1` -> audit, all or nothing. The audit carries only
// `{ version, ruleCount }`, never the rules.
@Injectable()
export class ReplaceAgentPolicyUseCase {
  constructor(
    private readonly access: OrganizationAccess,
    private readonly directory: OrganizationDirectory,
    private readonly policies: AgentPolicyRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(
    actor: Actor,
    organizationId: string,
    input: { baseVersion: number; rules: unknown },
  ): Promise<AgentPolicyView> {
    // A session opened through a Hub (`actor.hubId`) never rewrites the ACL (a pc agent acting with its owner's hub
    // session must not change its own limits): the same 404 an outsider gets, as the cloud does with its decisions
    // (`refuseHubSession`, which `agents` cannot import). Checked first, before any read. Reading stays allowed.
    if (actor.hubId) {
      throw new NotFoundError(
        'organization-not-found',
        'The organization was not found.',
      );
    }
    await this.access.requirePermission(
      organizationId,
      actor.userId,
      'org.agents.manage',
    );
    const rules = parseAgentRules(input.rules);
    return this.uow.run(async () => {
      if (!(await this.directory.lockForAgentPolicy(organizationId))) {
        throw new NotFoundError(
          'organization-not-found',
          'The organization was not found.',
        );
      }
      const current =
        (await this.policies.latest(organizationId))?.version ?? 0;
      const version = nextPolicyVersion(current, input.baseVersion);
      await this.policies.append({
        organizationId,
        version,
        rules,
        changedByUserId: actor.userId,
      });
      await this.audit.record({
        organizationId,
        userId: actor.userId,
        action: 'organization.agent_policy.changed',
        metadata: { version, ruleCount: rules.length },
      });
      return { organizationId, version, rules };
    });
  }
}

export type HubAgentPolicyItem = {
  organizationId: string;
  version: number;
  rules: AgentRule[];
};

// `GET /hub/agent/policy` (token of a `pc` hub): for EACH organization with an approved link, the version and only the
// rules that apply to the owner of the hub (`all` and `user:<owner>`; a rule about another person never leaves). An
// organization with no policy comes with version 0 and no rules (the agent denies by default). Nothing is
// authorized by the caller here: the hub and its links are what the token and the database say.
@Injectable()
export class GetHubAgentPolicyUseCase {
  constructor(
    private readonly hubs: HubDirectory,
    private readonly reader: AgentPolicyReader,
  ) {}

  async execute(hub: HubAuthContext): Promise<HubAgentPolicyItem[]> {
    const owner = await this.hubs.ownerOf(hub.hubId);
    if (!owner) throw pcHubNotFound();
    const items: HubAgentPolicyItem[] = [];
    for (const organizationId of await this.hubs.approvedOrganizationIds(
      hub.hubId,
    )) {
      const { version, rules } = await this.reader.current(organizationId);
      items.push({ organizationId, version, rules: rulesFor(rules, owner) });
    }
    return items;
  }
}
