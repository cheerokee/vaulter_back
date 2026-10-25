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
        plan: row.plan,
        recoveryPublicKey: row.recoveryPublicKey,
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
      plan: org.plan,
      recoveryPublicKey: org.recoveryPublicKey,
    };
  },
};
