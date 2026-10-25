import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import type {
  CursorPage,
  CursorPageRequest,
} from '../../shared/domain/pagination.js';
import { InvitationRepository } from '../domain/invitation.repository.js';
import {
  toInvitationView,
  type InvitationView,
} from './dto/invitation-view.js';
import { OrganizationAccess } from './organization-access.js';

@Injectable()
export class ListInvitationsUseCase {
  constructor(
    private readonly access: OrganizationAccess,
    private readonly invitations: InvitationRepository,
  ) {}

  async execute(
    actor: Actor,
    orgId: string,
    page: CursorPageRequest,
  ): Promise<CursorPage<InvitationView>> {
    await this.access.requirePermission(
      orgId,
      actor.userId,
      'org.members.manage',
    );
    const now = new Date();
    const result = await this.invitations.listPending(orgId, page, now);
    return {
      items: result.items.map((i) => toInvitationView(i, now)),
      nextCursor: result.nextCursor,
    };
  }
}
