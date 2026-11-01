import { HubOrganizationLink } from '../../domain/hub-organization-link.js';
import type { HubOrganizationTypeormEntity } from './hub-organization.entity.js';

// A tabela não tem coluna id (PK = hub_id, organization_id): o id da entidade de domínio não é persistido.
export const HubOrganizationMapper = {
  toDomain(row: HubOrganizationTypeormEntity): HubOrganizationLink {
    return HubOrganizationLink.restore({
      hubId: row.hubId,
      organizationId: row.organizationId,
      status: row.status,
      requestedByUserId: row.requestedByUserId,
      ownerApprovedByUserId: row.ownerApprovedByUserId,
      ownerApprovedAt: row.ownerApprovedAt,
      orgApprovedByUserId: row.orgApprovedByUserId,
      orgApprovedAt: row.orgApprovedAt,
      createdAt: row.createdAt,
    });
  },
};
