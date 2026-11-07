import { Entity } from '../../shared/domain/entity.js';
import {
  ConflictError,
  DomainValidationError,
} from '../../shared/domain/errors.js';

export const SUPPORT_REQUEST_TYPES = [
  'hub_force_deregister',
  'org_appoint_admin',
] as const;
export type PlatformSupportRequestType = (typeof SUPPORT_REQUEST_TYPES)[number];

export const SUPPORT_REQUEST_STATUSES = [
  'pending',
  'executed',
  'rejected',
  'expired',
  'failed',
] as const;
export type PlatformSupportRequestStatus =
  (typeof SUPPORT_REQUEST_STATUSES)[number];

/** A pending request without a decision expires after this many days (spec §4.3). */
export const SUPPORT_REQUEST_TTL_DAYS = 7;
/** Max length of the reason, the evidence and the decision note. */
export const SUPPORT_REQUEST_TEXT_MAX = 2000;

/** What the request acts on: the hub (forced deregistration) or the organization + the appointed person. */
export type SupportRequestTarget = {
  hubId?: string | null;
  organizationId?: string | null;
  userId?: string | null;
};

export type SupportRequestProps = {
  type: PlatformSupportRequestType;
  status: PlatformSupportRequestStatus;
  targetHubId: string | null;
  targetOrganizationId: string | null;
  targetUserId: string | null;
  reason: string;
  evidence: string;
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  executedAt: Date | null;
  failureType: string | null;
  expiresAt: Date;
  createdAt?: Date;
};

function text(value: unknown, code: string, what: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > SUPPORT_REQUEST_TEXT_MAX
  ) {
    throw new DomainValidationError(
      code,
      `The ${what} must have 1 to ${SUPPORT_REQUEST_TEXT_MAX} characters.`,
    );
  }
  return value;
}

function invalidTarget(): DomainValidationError {
  return new DomainValidationError(
    'support-request-target-invalid',
    'hub_force_deregister takes only hubId; org_appoint_admin takes organizationId and userId.',
  );
}

export function supportRequestExpired(): DomainValidationError {
  return new DomainValidationError(
    'support-request-expired',
    'The support request expired without a decision.',
  );
}

/**
 * A support request of the platform team (spec §4.3). States: `pending` (waiting for a decision, or approved and
 * waiting for the execution in the same transaction: `isApproved`), then `executed` / `failed` after an approval,
 * `rejected`, or `expired` (pending without a decision for 7 days). Whoever asked never decides (`self-approval`),
 * except when created approved by someone who may execute alone.
 */
export class SupportRequest extends Entity<SupportRequestProps> {
  static create(input: {
    type: PlatformSupportRequestType;
    target: SupportRequestTarget;
    reason: string;
    evidence: string;
    requestedBy: string;
    now: Date;
    /** Created by someone with `platform.support.execute_alone`: approved by the requester on creation. */
    approvedOnCreation?: boolean;
  }): SupportRequest {
    const hubId = input.target.hubId ?? null;
    const organizationId = input.target.organizationId ?? null;
    const userId = input.target.userId ?? null;
    if (input.type === 'hub_force_deregister') {
      if (!hubId || organizationId || userId) throw invalidTarget();
    } else if (input.type === 'org_appoint_admin') {
      if (hubId || !organizationId || !userId) throw invalidTarget();
    } else {
      throw invalidTarget();
    }
    const approved = input.approvedOnCreation === true;
    return new SupportRequest({
      type: input.type,
      status: 'pending',
      targetHubId: hubId,
      targetOrganizationId: organizationId,
      targetUserId: userId,
      reason: text(input.reason, 'support-request-reason-invalid', 'reason'),
      evidence: text(
        input.evidence,
        'support-request-evidence-invalid',
        'evidence',
      ),
      requestedBy: input.requestedBy,
      decidedBy: approved ? input.requestedBy : null,
      decidedAt: approved ? input.now : null,
      decisionNote: null,
      executedAt: null,
      failureType: null,
      expiresAt: new Date(
        input.now.getTime() + SUPPORT_REQUEST_TTL_DAYS * 86_400_000,
      ),
      createdAt: input.now,
    });
  }

  static restore(props: SupportRequestProps, id: string): SupportRequest {
    return new SupportRequest(props, id);
  }

  /** Pending without a decision at or past the deadline becomes `expired`. True when it changed the state. */
  expireIfDue(now: Date): boolean {
    if (this.props.status !== 'pending' || this.isApproved) return false;
    if (now < this.props.expiresAt) return false;
    this.props = { ...this.props, status: 'expired' };
    return true;
  }

  approve(deciderId: string, now: Date): void {
    this.assertDecidable(deciderId, now);
    this.props = { ...this.props, decidedBy: deciderId, decidedAt: now };
  }

  reject(deciderId: string, note: string, now: Date): void {
    const decisionNote = text(note, 'decision-note-invalid', 'decision note');
    this.assertDecidable(deciderId, now);
    this.props = {
      ...this.props,
      status: 'rejected',
      decidedBy: deciderId,
      decidedAt: now,
      decisionNote,
    };
  }

  markExecuted(now: Date): void {
    this.assertApproved();
    this.props = { ...this.props, status: 'executed', executedAt: now };
  }

  /** `failureType`: the stable `type` of the domain error that stopped the execution. */
  markFailed(failureType: string): void {
    this.assertApproved();
    this.props = { ...this.props, status: 'failed', failureType };
  }

  // Order: the state (an expired request answers expired even to its requester), then who decides.
  private assertDecidable(deciderId: string, now: Date): void {
    if (this.expireIfDue(now) || this.props.status === 'expired') {
      throw supportRequestExpired();
    }
    if (this.props.status !== 'pending' || this.isApproved) {
      throw new ConflictError(
        'support-request-not-pending',
        'The support request was already decided.',
      );
    }
    if (deciderId === this.props.requestedBy) {
      throw new DomainValidationError(
        'self-approval',
        'Whoever asked cannot decide their own support request.',
      );
    }
  }

  private assertApproved(): void {
    if (this.props.status !== 'pending' || !this.isApproved) {
      throw new ConflictError(
        'support-request-not-pending',
        'The support request is not approved and waiting for execution.',
      );
    }
  }

  /** Approved and waiting for the execution (it never stays like this after the transaction). */
  get isApproved(): boolean {
    return this.props.status === 'pending' && this.props.decidedBy !== null;
  }
  get type(): PlatformSupportRequestType {
    return this.props.type;
  }
  get status(): PlatformSupportRequestStatus {
    return this.props.status;
  }
  get targetHubId(): string | null {
    return this.props.targetHubId;
  }
  get targetOrganizationId(): string | null {
    return this.props.targetOrganizationId;
  }
  get targetUserId(): string | null {
    return this.props.targetUserId;
  }
  get reason(): string {
    return this.props.reason;
  }
  get evidence(): string {
    return this.props.evidence;
  }
  get requestedBy(): string {
    return this.props.requestedBy;
  }
  get decidedBy(): string | null {
    return this.props.decidedBy;
  }
  get decidedAt(): Date | null {
    return this.props.decidedAt;
  }
  get decisionNote(): string | null {
    return this.props.decisionNote;
  }
  get executedAt(): Date | null {
    return this.props.executedAt;
  }
  get failureType(): string | null {
    return this.props.failureType;
  }
  get expiresAt(): Date {
    return this.props.expiresAt;
  }
  get createdAt(): Date | undefined {
    return this.props.createdAt;
  }
}
