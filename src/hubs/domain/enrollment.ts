import {
  ConflictError,
  DomainValidationError,
} from '../../shared/domain/errors.js';
import { Entity } from '../../shared/domain/entity.js';
import {
  assertEncryptionPublicKey,
  assertSigningPublicKey,
} from './hub-keys.js';

export const ENROLLMENT_TTL_MS = 10 * 60 * 1000;

export type EnrollmentStatus = 'pending' | 'claimed' | 'expired';

export type EnrollmentProps = {
  signingPublicKey: string;
  encryptionPublicKey: string;
  nonce: string;
  claimCodeHash: string;
  expiresAt: Date;
  status: EnrollmentStatus;
  claimedHubId: string | null;
  createdAt?: Date;
};

export class Enrollment extends Entity<EnrollmentProps> {
  static issue(input: {
    keys: { signingPublicKey: string; encryptionPublicKey: string };
    nonce: string;
    codeHash: string;
    now: Date;
  }): Enrollment {
    if (typeof input.nonce !== 'string' || input.nonce.length === 0) {
      throw new DomainValidationError(
        'nonce-invalid',
        'The nonce is required.',
      );
    }
    return new Enrollment({
      signingPublicKey: assertSigningPublicKey(input.keys.signingPublicKey),
      encryptionPublicKey: assertEncryptionPublicKey(
        input.keys.encryptionPublicKey,
      ),
      nonce: input.nonce,
      claimCodeHash: input.codeHash,
      expiresAt: new Date(input.now.getTime() + ENROLLMENT_TTL_MS),
      status: 'pending',
      claimedHubId: null,
      createdAt: input.now,
    });
  }

  static restore(props: EnrollmentProps, id: string): Enrollment {
    return new Enrollment(props, id);
  }

  get signingPublicKey(): string {
    return this.props.signingPublicKey;
  }
  get encryptionPublicKey(): string {
    return this.props.encryptionPublicKey;
  }
  get nonce(): string {
    return this.props.nonce;
  }
  get claimCodeHash(): string {
    return this.props.claimCodeHash;
  }
  get expiresAt(): Date {
    return this.props.expiresAt;
  }
  get status(): EnrollmentStatus {
    return this.props.status;
  }
  get claimedHubId(): string | null {
    return this.props.claimedHubId;
  }
  get createdAt(): Date | undefined {
    return this.props.createdAt;
  }

  /** Same error for expired, already claimed and (at the use case) unknown code: no oracle. */
  assertClaimable(now: Date): void {
    if (
      this.props.status !== 'pending' ||
      now.getTime() >= this.props.expiresAt.getTime()
    ) {
      throw new ConflictError(
        'claim-code-invalid',
        'The claim code is invalid or expired.',
      );
    }
  }

  markClaimed(hubId: string): void {
    this.props = { ...this.props, status: 'claimed', claimedHubId: hubId };
  }
}
