import type { OrgRoleKey } from '../../domain/membership.js';
import type {
  HubLinkPolicy,
  Organization,
  PlatformAppointment,
} from '../../domain/organization.js';

export type OrganizationView = {
  id: string;
  name: string;
  isPersonal: boolean;
  hubLinkPolicy: HubLinkPolicy;
  allowRoomSpaces: boolean;
  plan: string;
  recoveryPublicKey: string | null;
  /** Last registration/replacement of the kit (the app shows who/when before rewrapping to a new kit). */
  recoveryKeyChangedAt: Date | null;
  recoveryKeyChangedByUserId: string | null;
  /**
   * Latest platform appointment while it is relevant (until `protectedUntil` + 30 days), else null: the app warns
   * every member while it is present.
   */
  platformAppointment: PlatformAppointment | null;
  /** The caller's organization role. */
  roleKey: OrgRoleKey;
  createdAt: Date;
  updatedAt: Date;
};

export function toOrganizationView(
  org: Organization,
  roleKey: OrgRoleKey,
  now: Date,
): OrganizationView {
  if (!org.createdAt) {
    throw new Error('Organization without createdAt cannot be viewed');
  }
  return {
    id: org.id,
    name: org.name,
    isPersonal: org.isPersonal,
    hubLinkPolicy: org.hubLinkPolicy,
    allowRoomSpaces: org.allowRoomSpaces,
    plan: org.plan,
    recoveryPublicKey: org.recoveryPublicKey,
    recoveryKeyChangedAt: org.recoveryKeyChangedAt,
    recoveryKeyChangedByUserId: org.recoveryKeyChangedByUserId,
    platformAppointment: org.platformAppointmentNotice(now),
    roleKey,
    createdAt: org.createdAt,
    // Recém-criada (ainda sem o valor do banco): igual à criação.
    updatedAt: org.updatedAt ?? org.createdAt,
  };
}
