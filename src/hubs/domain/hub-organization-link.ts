import { ConflictError } from '../../shared/domain/errors.js';
import { Entity } from '../../shared/domain/entity.js';

/** Same string values as organizations' HUB_LINK_POLICIES (declared locally: no cross-module domain import). */
export type HubLinkPolicy = 'any_member_hub' | 'admin_approved';
export type HubLinkStatus = 'pending' | 'approved' | 'rejected' | 'revoked';

export type HubOrganizationLinkProps = {
  hubId: string;
  organizationId: string;
  status: HubLinkStatus;
  requestedByUserId: string;
  ownerApprovedByUserId: string | null;
  ownerApprovedAt: Date | null;
  /** Only a real admin consent is recorded; under any_member_hub the org side is satisfied by the policy itself. */
  orgApprovedByUserId: string | null;
  orgApprovedAt: Date | null;
  createdAt?: Date;
};

type Start = {
  hubId: string;
  organizationId: string;
  userId: string;
  policy: HubLinkPolicy;
  now: Date;
  /** The current row for (hub, organization), if any: rejected/revoked ones restart as a new request. */
  existing?: HubOrganizationLink | null;
};

function begin(
  input: Start,
  consent: Pick<
    HubOrganizationLinkProps,
    | 'ownerApprovedByUserId'
    | 'ownerApprovedAt'
    | 'orgApprovedByUserId'
    | 'orgApprovedAt'
  >,
): HubOrganizationLink {
  const { existing } = input;
  if (existing && (existing.status === 'pending' || existing.isActive)) {
    throw new ConflictError(
      'already-linked',
      'The hub already has a link or pending request with this organization.',
    );
  }
  const props: HubOrganizationLinkProps = {
    hubId: input.hubId,
    organizationId: input.organizationId,
    status:
      consent.ownerApprovedAt !== null &&
      (input.policy === 'any_member_hub' || consent.orgApprovedAt !== null)
        ? 'approved'
        : 'pending',
    requestedByUserId: input.userId,
    ...consent,
    createdAt: existing?.createdAt ?? input.now,
  };
  return HubOrganizationLink.restore(props, existing?.id);
}

export class HubOrganizationLink extends Entity<HubOrganizationLinkProps> {
  /** The hub owner asks: owner consent is given; approved at once under any_member_hub (no org consent stamped). */
  static ownerLinks(input: Start): HubOrganizationLink {
    return begin(input, {
      ownerApprovedByUserId: input.userId,
      ownerApprovedAt: input.now,
      orgApprovedByUserId: null,
      orgApprovedAt: null,
    });
  }

  /** Another member asks (via link code): the owner must approve, and an admin too under admin_approved. */
  static requestByOther(input: Start): HubOrganizationLink {
    return begin(input, {
      ownerApprovedByUserId: null,
      ownerApprovedAt: null,
      orgApprovedByUserId: null,
      orgApprovedAt: null,
    });
  }

  static restore(
    props: HubOrganizationLinkProps,
    id?: string,
  ): HubOrganizationLink {
    return new HubOrganizationLink(props, id);
  }

  get hubId(): string {
    return this.props.hubId;
  }
  get organizationId(): string {
    return this.props.organizationId;
  }
  get status(): HubLinkStatus {
    return this.props.status;
  }
  get requestedByUserId(): string {
    return this.props.requestedByUserId;
  }
  get ownerApprovedByUserId(): string | null {
    return this.props.ownerApprovedByUserId;
  }
  get ownerApprovedAt(): Date | null {
    return this.props.ownerApprovedAt;
  }
  get orgApprovedByUserId(): string | null {
    return this.props.orgApprovedByUserId;
  }
  get orgApprovedAt(): Date | null {
    return this.props.orgApprovedAt;
  }
  get createdAt(): Date | undefined {
    return this.props.createdAt;
  }
  get isActive(): boolean {
    return this.props.status === 'approved';
  }

  approveAsOwner(userId: string, now: Date, policy: HubLinkPolicy): void {
    this.assertPending();
    if (this.props.ownerApprovedAt === null) {
      this.props = {
        ...this.props,
        ownerApprovedByUserId: userId,
        ownerApprovedAt: now,
      };
    }
    this.settle(policy);
  }

  approveAsOrgAdmin(userId: string, now: Date, policy: HubLinkPolicy): void {
    this.assertPending();
    if (this.props.orgApprovedAt === null) {
      this.props = {
        ...this.props,
        orgApprovedByUserId: userId,
        orgApprovedAt: now,
      };
    }
    this.settle(policy);
  }

  reject(): void {
    this.assertPending();
    this.props = { ...this.props, status: 'rejected' };
  }

  /** Owner or admin unlinks at any time: valid from pending (cancel) or approved. */
  revoke(): void {
    if (this.props.status !== 'pending' && this.props.status !== 'approved') {
      throw new ConflictError(
        'link-not-active',
        'The link is not active or pending.',
      );
    }
    this.props = { ...this.props, status: 'revoked' };
  }

  private assertPending(): void {
    if (this.props.status !== 'pending') {
      throw new ConflictError(
        'link-not-pending',
        'The link request is not pending.',
      );
    }
  }

  /** Approved when the owner consented and the org side is satisfied by the CURRENT policy or a real admin. */
  private settle(policy: HubLinkPolicy): void {
    if (
      this.props.status === 'pending' &&
      this.props.ownerApprovedAt !== null &&
      (policy === 'any_member_hub' || this.props.orgApprovedAt !== null)
    ) {
      this.props = { ...this.props, status: 'approved' };
    }
  }
}
