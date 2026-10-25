import { DomainValidationError } from '../../shared/domain/errors.js';
import { Entity } from '../../shared/domain/entity.js';
import { assertInvitationEmail, normalizeEmail } from './email.js';
import { isOrgRoleKey, type OrgRoleKey } from './membership.js';

export const INVITATION_TTL_DAYS = 7;

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export type InvitationProps = {
  organizationId: string;
  tokenHash: string;
  email: string | null;
  roleKey: OrgRoleKey;
  status: InvitationStatus;
  expiresAt: Date;
  createdBy: string;
  acceptedBy: string | null;
  acceptedAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
};

function invalid(): never {
  throw new DomainValidationError(
    'invitation-invalid',
    'The invitation is not valid.',
  );
}

/**
 * The raw token never enters the domain: the application layer generates it (InvitationTokenCodec) and
 * hands only the hash here. Only the hash is stored and exposed.
 */
export class Invitation extends Entity<InvitationProps> {
  static issue(input: {
    organizationId: string;
    roleKey: OrgRoleKey;
    email?: string | null;
    createdBy: string;
    tokenHash: string;
    now: Date;
  }): Invitation {
    if (!isOrgRoleKey(input.roleKey)) {
      throw new DomainValidationError(
        'role-invalid',
        'The role must be org_admin or org_member.',
      );
    }
    if (typeof input.tokenHash !== 'string' || input.tokenHash.length === 0) {
      throw new DomainValidationError(
        'invitation-token-hash-invalid',
        'The token hash is required.',
      );
    }
    return new Invitation({
      organizationId: input.organizationId,
      tokenHash: input.tokenHash,
      email: input.email ? assertInvitationEmail(input.email) : null,
      roleKey: input.roleKey,
      status: 'pending',
      expiresAt: new Date(
        input.now.getTime() + INVITATION_TTL_DAYS * 86_400_000,
      ),
      createdBy: input.createdBy,
      acceptedBy: null,
      acceptedAt: null,
      createdAt: input.now,
    });
  }

  static restore(props: InvitationProps, id: string): Invitation {
    return new Invitation(props, id);
  }

  /** `pending` past its deadline reads as `expired` (the column is never rewritten by a clock). */
  effectiveStatus(now: Date): InvitationStatus {
    return this.props.status === 'pending' && now >= this.props.expiresAt
      ? 'expired'
      : this.props.status;
  }

  canBeAcceptedBy(email: string, now: Date): boolean {
    if (this.effectiveStatus(now) !== 'pending') return false;
    return (
      this.props.email === null || this.props.email === normalizeEmail(email)
    );
  }

  accept(userId: string, now: Date, email?: string): void {
    if (email !== undefined && !this.canBeAcceptedBy(email, now)) invalid();
    if (this.effectiveStatus(now) !== 'pending') invalid();
    this.props = {
      ...this.props,
      status: 'accepted',
      acceptedBy: userId,
      acceptedAt: now,
    };
  }

  revoke(): void {
    if (this.props.status !== 'pending') invalid();
    this.props = { ...this.props, status: 'revoked' };
  }

  get organizationId(): string {
    return this.props.organizationId;
  }
  get tokenHash(): string {
    return this.props.tokenHash;
  }
  get email(): string | null {
    return this.props.email;
  }
  get roleKey(): OrgRoleKey {
    return this.props.roleKey;
  }
  get status(): InvitationStatus {
    return this.props.status;
  }
  get expiresAt(): Date {
    return this.props.expiresAt;
  }
  get createdBy(): string {
    return this.props.createdBy;
  }
  get acceptedBy(): string | null {
    return this.props.acceptedBy;
  }
  get acceptedAt(): Date | null {
    return this.props.acceptedAt;
  }
  get createdAt(): Date | undefined {
    return this.props.createdAt;
  }
  get updatedAt(): Date | undefined {
    return this.props.updatedAt;
  }
}
