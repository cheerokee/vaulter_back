import type {
  HubLinkStatus,
  HubOrganizationLink,
} from '../../domain/hub-organization-link.js';
import type { HubSpaceRef } from '../../domain/hub-space.repository.js';

export type HubLinkView = {
  hubId: string;
  organizationId: string;
  status: HubLinkStatus;
  requestedByUserId: string;
  ownerApprovedAt: Date | null;
  orgApprovedAt: Date | null;
  createdAt: Date | null;
};

export function toHubLinkView(link: HubOrganizationLink): HubLinkView {
  return {
    hubId: link.hubId,
    organizationId: link.organizationId,
    status: link.status,
    requestedByUserId: link.requestedByUserId,
    ownerApprovedAt: link.ownerApprovedAt,
    orgApprovedAt: link.orgApprovedAt,
    createdAt: link.createdAt ?? null,
  };
}

/** A link or request as an org admin lists it (`GET /organizations/:orgId/hub-links`): with the hub's name. */
export type OrganizationHubLinkView = HubLinkView & { hubName: string | null };

/** What the requester of a link learns: never the hub id (they only proved they stand in front of the device). */
export type HubLinkRequestView = {
  organizationId: string;
  status: HubLinkStatus;
};

export type HubSpaceView = HubSpaceRef;
