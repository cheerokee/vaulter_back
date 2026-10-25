import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import type {
  CursorPage,
  CursorPageRequest,
} from '../../shared/domain/pagination.js';
import { OrganizationRepository } from '../domain/organization.repository.js';
import {
  toOrganizationView,
  type OrganizationView,
} from './dto/organization-view.js';

@Injectable()
export class ListMyOrganizationsUseCase {
  constructor(private readonly orgs: OrganizationRepository) {}

  async execute(
    actor: Actor,
    page: CursorPageRequest,
  ): Promise<CursorPage<OrganizationView>> {
    const result = await this.orgs.listForUser(actor.userId, page);
    return {
      items: result.items.map((i) =>
        toOrganizationView(i.organization, i.roleKey),
      ),
      nextCursor: result.nextCursor,
    };
  }
}
