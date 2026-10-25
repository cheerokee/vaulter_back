import { DomainValidationError } from '../../shared/domain/errors.js';
import { Entity } from '../../shared/domain/entity.js';
import { assertRecoveryPublicKey } from './recovery-key.js';

export const HUB_LINK_POLICIES = ['any_member_hub', 'admin_approved'] as const;
export type HubLinkPolicy = (typeof HUB_LINK_POLICIES)[number];

export type OrganizationProps = {
  name: string;
  isPersonal: boolean;
  personalOwnerUserId: string | null;
  hubLinkPolicy: HubLinkPolicy;
  plan: string;
  recoveryPublicKey: string | null;
  createdAt?: Date;
  updatedAt?: Date;
};

function assertName(raw: string): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.length < 1 || name.length > 255) {
    throw new DomainValidationError(
      'organization-name-invalid',
      'The name must have between 1 and 255 characters.',
    );
  }
  return name;
}

export class Organization extends Entity<OrganizationProps> {
  /** `ownerId` is the creator, who becomes admin through a membership (not stored on the organization). */
  static create(input: {
    name: string;
    ownerId: string;
    now: Date;
  }): Organization {
    return new Organization({
      name: assertName(input.name),
      isPersonal: false,
      personalOwnerUserId: null,
      hubLinkPolicy: 'any_member_hub',
      plan: 'free',
      recoveryPublicKey: null,
      createdAt: input.now,
    });
  }

  static createPersonal(input: {
    name: string;
    ownerId: string;
    now: Date;
  }): Organization {
    return new Organization({
      name: assertName(input.name),
      isPersonal: true,
      personalOwnerUserId: input.ownerId,
      hubLinkPolicy: 'any_member_hub',
      plan: 'free',
      recoveryPublicKey: null,
      createdAt: input.now,
    });
  }

  static restore(props: OrganizationProps, id: string): Organization {
    return new Organization(props, id);
  }

  rename(name: string): void {
    this.props = { ...this.props, name: assertName(name) };
  }

  setHubLinkPolicy(policy: HubLinkPolicy): void {
    if (!HUB_LINK_POLICIES.includes(policy)) {
      throw new DomainValidationError(
        'hub-link-policy-invalid',
        'The hub link policy is invalid.',
      );
    }
    this.props = { ...this.props, hubLinkPolicy: policy };
  }

  /** Registers the first key or replaces the current one; validates before touching state. */
  setRecoveryKey(publicKey: string): 'registered' | 'replaced' {
    const key = assertRecoveryPublicKey(publicKey);
    const outcome = this.props.recoveryPublicKey ? 'replaced' : 'registered';
    this.props = { ...this.props, recoveryPublicKey: key };
    return outcome;
  }

  get name(): string {
    return this.props.name;
  }
  get isPersonal(): boolean {
    return this.props.isPersonal;
  }
  get personalOwnerUserId(): string | null {
    return this.props.personalOwnerUserId;
  }
  get plan(): string {
    return this.props.plan;
  }
  get recoveryPublicKey(): string | null {
    return this.props.recoveryPublicKey;
  }
  get hubLinkPolicy(): HubLinkPolicy {
    return this.props.hubLinkPolicy;
  }
  get createdAt(): Date | undefined {
    return this.props.createdAt;
  }
  get updatedAt(): Date | undefined {
    return this.props.updatedAt;
  }
}
