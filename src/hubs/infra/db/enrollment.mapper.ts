import { Enrollment } from '../../domain/enrollment.js';
import type { HubEnrollmentTypeormEntity } from './hub-enrollment.entity.js';

export const EnrollmentMapper = {
  toDomain(row: HubEnrollmentTypeormEntity): Enrollment {
    return Enrollment.restore(
      {
        kind: row.kind,
        signingPublicKey: row.signingPublicKey,
        encryptionPublicKey: row.encryptionPublicKey,
        nonce: row.nonce,
        claimCodeHash: row.claimCodeHash,
        expiresAt: row.expiresAt,
        status: row.status,
        claimedHubId: row.claimedHubId,
        createdAt: row.createdAt,
      },
      row.id,
    );
  },

  toPersistence(e: Enrollment): Partial<HubEnrollmentTypeormEntity> {
    return {
      id: e.id,
      createdAt: e.createdAt,
      kind: e.kind,
      signingPublicKey: e.signingPublicKey,
      encryptionPublicKey: e.encryptionPublicKey,
      nonce: e.nonce,
      claimCodeHash: e.claimCodeHash,
      expiresAt: e.expiresAt,
      status: e.status,
      claimedHubId: e.claimedHubId,
    };
  },
};
