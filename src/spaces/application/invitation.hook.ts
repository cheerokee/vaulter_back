import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { validate } from 'uuid';
import {
  InvitationHooks,
  type InvitationAcceptedContext,
  type InvitationCreatedContext,
} from '../../shared/application/invitation-hooks.js';
import {
  NotFoundError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';
import { newId } from '../../shared/domain/id.js';
import { PendingGrantRepository } from '../domain/pending-grant.repository.js';
import { SpaceIntentRepository } from '../domain/space-intent.repository.js';
import { SpaceMembershipRules } from '../domain/space-membership.js';
import { SpaceRoleRepository } from '../domain/space-role.repository.js';
import { SpaceRepository } from '../domain/space.repository.js';

const HOOK_NAME = 'spaces.invitation';

// Convite com espaços (decisão 9). Os dois lados rodam no unit of work do `organizations` (criar / aceitar).
// - validateAndRecord: cada espaço precisa existir NA organização do convite (senão 404 `space-not-found`, o
//   mesmo para id de outra organização ou malformado: a busca roda no escopo de RLS da organização) e quem
//   convida precisa ser Gestor dele (senão 403). Grava as intenções.
// - onAccepted: uma pendência de trancar por intenção. Pula o espaço que sumiu, aquele em que a pessoa já está
//   e aquele com pendência aberta para ela (o aceite não falha por isso). `requestedByUserId` fica nulo: a
//   intenção não guarda quem indicou e o contexto do aceite não traz o criador do convite.
@Injectable()
export class SpacesInvitationHook implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly hooks: InvitationHooks,
    private readonly spaces: SpaceRepository,
    private readonly roles: SpaceRoleRepository,
    private readonly intents: SpaceIntentRepository,
    private readonly pending: PendingGrantRepository,
  ) {}

  onModuleInit(): void {
    this.hooks.register({
      name: HOOK_NAME,
      validateAndRecord: (ctx) => this.validateAndRecord(ctx),
      onAccepted: (ctx) => this.onAccepted(ctx),
    });
  }

  onModuleDestroy(): void {
    this.hooks.unregister(HOOK_NAME);
  }

  async validateAndRecord(ctx: InvitationCreatedContext): Promise<void> {
    const orgId = ctx.organizationId;
    const intents = [];
    for (const intent of ctx.spaces) {
      const roleKey = SpaceMembershipRules.assertSpaceRole(intent.roleKey);
      const space = validate(intent.spaceId)
        ? await this.spaces.findById(orgId, intent.spaceId)
        : null;
      if (!space) {
        throw new NotFoundError('space-not-found', 'The space was not found.');
      }
      const actorRole = await this.roles.roleOf(orgId, space.id, ctx.actorId);
      if (actorRole !== 'space_manager') {
        throw new PermissionDeniedError(
          'permission-denied',
          'Only a manager of the space can invite to it.',
        );
      }
      intents.push({ spaceId: space.id, roleKey });
    }
    await this.intents.record(orgId, ctx.invitationId, intents);
  }

  async onAccepted(ctx: InvitationAcceptedContext): Promise<void> {
    const orgId = ctx.organizationId;
    for (const intent of await this.intents.forInvitation(
      orgId,
      ctx.invitationId,
    )) {
      if (!(await this.spaces.findById(orgId, intent.spaceId))) continue;
      if (await this.roles.roleOf(orgId, intent.spaceId, ctx.userId)) continue;
      if (await this.pending.findPending(orgId, intent.spaceId, ctx.userId)) {
        continue;
      }
      await this.pending.create(orgId, {
        id: newId(),
        spaceId: intent.spaceId,
        userId: ctx.userId,
        roleKey: intent.roleKey,
        invitationId: ctx.invitationId,
        requestedByUserId: null,
      });
    }
  }
}
