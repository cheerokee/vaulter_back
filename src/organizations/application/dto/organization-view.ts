import type { OrgRoleKey } from '../../domain/membership.js';
import type { HubLinkPolicy, Organization } from '../../domain/organization.js';

export type OrganizationView = {
  id: string;
  name: string;
  isPersonal: boolean;
  hubLinkPolicy: HubLinkPolicy;
  plan: string;
  recoveryPublicKey: string | null;
  /** The caller's organization role. */
  roleKey: OrgRoleKey;
  createdAt: Date;
  updatedAt: Date;
};

export function toOrganizationView(
  org: Organization,
  roleKey: OrgRoleKey,
): OrganizationView {
  if (!org.createdAt) {
    throw new Error('Organization without createdAt cannot be viewed');
  }
  return {
    id: org.id,
    name: org.name,
    isPersonal: org.isPersonal,
    hubLinkPolicy: org.hubLinkPolicy,
    plan: org.plan,
    recoveryPublicKey: org.recoveryPublicKey,
    roleKey,
    createdAt: org.createdAt,
    // Recém-criada (ainda sem o valor do banco): igual à criação.
    updatedAt: org.updatedAt ?? org.createdAt,
  };
}
