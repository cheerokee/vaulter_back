import type { HubOrganizationLink } from './hub-organization-link.js';

export abstract class HubOrganizationRepository {
  abstract find(
    hubId: string,
    organizationId: string,
  ): Promise<HubOrganizationLink | null>;
  /** Insert, or update the existing (hub, organization) row, reviving a tombstone. */
  abstract upsert(link: HubOrganizationLink): Promise<void>;
  abstract list(hubId: string): Promise<HubOrganizationLink[]>;
  /** Organizations with an approved link. */
  abstract listActiveOrgIds(hubId: string): Promise<string[]>;
  /** SELECT ... FOR UPDATE on the (hub, organization) row. REQUIRES an active unit of work. */
  abstract lockForUpdate(
    hubId: string,
    organizationId: string,
  ): Promise<HubOrganizationLink | null>;
}
