import { Organization } from '../../domain/organization.js';
import { OrganizationTypeormEntity } from './organization.entity.js';

export const OrganizationMapper = {
  toDomain(row: OrganizationTypeormEntity): Organization {
    return Organization.restore(
      {
        name: row.name,
        isPersonal: row.isPersonal,
        personalOwnerUserId: row.personalOwnerUserId,
        hubLinkPolicy: row.hubLinkPolicy,
        allowRoomSpaces: row.allowRoomSpaces,
        plan: row.plan,
        recoveryPublicKey: row.recoveryPublicKey,
        recoveryKeyChangedAt: row.recoveryKeyChangedAt,
        recoveryKeyChangedByUserId: row.recoveryKeyChangedByUserId,
        // The CHECK keeps the three columns together.
        platformAppointment:
          row.platformAppointedUserId &&
          row.platformAppointedAt &&
          row.protectedUntil
            ? {
                appointedUserId: row.platformAppointedUserId,
                appointedAt: row.platformAppointedAt,
                protectedUntil: row.protectedUntil,
              }
            : null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt ?? undefined,
      },
      row.id,
    );
  },

  // createdAt vem do domínio (explícito no insert); updatedAt e syncVersion ficam com o banco.
  toPersistence(org: Organization): Partial<OrganizationTypeormEntity> {
    return {
      id: org.id,
      createdAt: org.createdAt,
      name: org.name,
      isPersonal: org.isPersonal,
      personalOwnerUserId: org.personalOwnerUserId,
      hubLinkPolicy: org.hubLinkPolicy,
      allowRoomSpaces: org.allowRoomSpaces,
      plan: org.plan,
      recoveryPublicKey: org.recoveryPublicKey,
      recoveryKeyChangedAt: org.recoveryKeyChangedAt,
      recoveryKeyChangedByUserId: org.recoveryKeyChangedByUserId,
      platformAppointedUserId: org.platformAppointment?.appointedUserId ?? null,
      platformAppointedAt: org.platformAppointment?.appointedAt ?? null,
      protectedUntil: org.platformAppointment?.protectedUntil ?? null,
    };
  },
};
