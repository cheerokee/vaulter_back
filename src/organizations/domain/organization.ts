import { DomainValidationError } from '../../shared/domain/errors.js';
import { Entity } from '../../shared/domain/entity.js';
import { assertRecoveryPublicKey } from './recovery-key.js';
import { AI_BUDGET_DEFAULT_MICRO_USD, assertAiBudget } from './ai-budget.js';
import { ORGANIZATION_STORAGE_QUOTA_DEFAULT_BYTES } from './storage-quota.js';

export const HUB_LINK_POLICIES = ['any_member_hub', 'admin_approved'] as const;
export type HubLinkPolicy = (typeof HUB_LINK_POLICIES)[number];

/**
 * Protection window after a platform-appointed admin (decisão do Jonas, 09/11/2026): while it lasts nobody in the
 * organization replaces/registers the recovery kit or removes a member, so a single platform operator (or someone
 * they promote) cannot take over the spaces through the kit.
 */
export const PLATFORM_APPOINTMENT_PROTECTION_DAYS = 7;
/** How long after the window the appointment is still shown to members (the app keeps warning about it). */
export const PLATFORM_APPOINTMENT_NOTICE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type PlatformAppointment = {
  appointedUserId: string;
  appointedAt: Date;
  protectedUntil: Date;
};

export type OrganizationProps = {
  name: string;
  isPersonal: boolean;
  personalOwnerUserId: string | null;
  hubLinkPolicy: HubLinkPolicy;
  /** Organization policy: members may open spaces in a Hub's Room (only for NEW room grants). */
  allowRoomSpaces: boolean;
  plan: string;
  recoveryPublicKey: string | null;
  /** When and by whom the recovery kit was last registered or replaced (the app warns members before rewrapping). */
  recoveryKeyChangedAt: Date | null;
  recoveryKeyChangedByUserId: string | null;
  /** Latest platform appointment (overwritten by a new one); null if never. */
  platformAppointment: PlatformAppointment | null;
  /** Cloud quota (bytes): the reserved sizes of the live spaces never add up beyond it. */
  storageQuotaBytes: number;
  /** Monthly AI budget in micro-USD (spec active-cloud §4.4); 0 = nothing that costs AI runs. */
  aiBudgetMicroUsd: bigint;
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
  /** The creator becomes admin through a membership; nothing about them is stored here. */
  static create(input: { name: string; now: Date }): Organization {
    return new Organization({
      name: assertName(input.name),
      isPersonal: false,
      personalOwnerUserId: null,
      hubLinkPolicy: 'any_member_hub',
      allowRoomSpaces: true,
      plan: 'free',
      recoveryPublicKey: null,
      recoveryKeyChangedAt: null,
      recoveryKeyChangedByUserId: null,
      platformAppointment: null,
      storageQuotaBytes: ORGANIZATION_STORAGE_QUOTA_DEFAULT_BYTES,
      aiBudgetMicroUsd: AI_BUDGET_DEFAULT_MICRO_USD,
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
      allowRoomSpaces: true,
      plan: 'free',
      recoveryPublicKey: null,
      recoveryKeyChangedAt: null,
      recoveryKeyChangedByUserId: null,
      platformAppointment: null,
      storageQuotaBytes: ORGANIZATION_STORAGE_QUOTA_DEFAULT_BYTES,
      aiBudgetMicroUsd: AI_BUDGET_DEFAULT_MICRO_USD,
      createdAt: input.now,
    });
  }

  static restore(props: OrganizationProps, id: string): Organization {
    // Data integrity (not user input): a personal org has an owner, a regular one does not.
    if (props.isPersonal !== (props.personalOwnerUserId !== null)) {
      throw new Error(
        `Organization ${id} is inconsistent: isPersonal and personalOwnerUserId disagree.`,
      );
    }
    if (
      (props.recoveryKeyChangedAt === null) !==
      (props.recoveryKeyChangedByUserId === null)
    ) {
      throw new Error(
        `Organization ${id} is inconsistent: recoveryKeyChangedAt and recoveryKeyChangedByUserId disagree.`,
      );
    }
    return new Organization(props, id);
  }

  /** Sets the cloud quota; the caller has already checked it against the reserved sum (under the row lock). */
  setStorageQuota(bytes: number): { fromBytes: number; toBytes: number } {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new DomainValidationError(
        'storage-quota-invalid',
        'The storage quota must be a positive number of bytes.',
      );
    }
    const fromBytes = this.props.storageQuotaBytes;
    this.props = { ...this.props, storageQuotaBytes: bytes };
    return { fromBytes, toBytes: bytes };
  }

  /** Sets the monthly AI budget (finance decides the value; lowering it below the month's spend only stops the AI). */
  setAiBudget(microUsd: bigint): { fromMicroUsd: bigint; toMicroUsd: bigint } {
    const toMicroUsd = assertAiBudget(microUsd);
    const fromMicroUsd = this.props.aiBudgetMicroUsd;
    this.props = { ...this.props, aiBudgetMicroUsd: toMicroUsd };
    return { fromMicroUsd, toMicroUsd };
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

  /** Turning it off blocks NEW room grants only; existing ones stay until removed (spec hubs §6). */
  setAllowRoomSpaces(allow: boolean): void {
    if (typeof allow !== 'boolean') {
      throw new DomainValidationError(
        'allow-room-spaces-invalid',
        'allowRoomSpaces must be a boolean.',
      );
    }
    this.props = { ...this.props, allowRoomSpaces: allow };
  }

  /**
   * Registers the first key or replaces the current one, recording who and when; validates before touching state.
   * Refused while the organization is under protection (`assertNotUnderProtection`), so no caller can bypass it.
   */
  setRecoveryKey(
    publicKey: string,
    by: { userId: string; now: Date },
  ): 'registered' | 'replaced' {
    this.assertNotUnderProtection(by.now);
    const key = assertRecoveryPublicKey(publicKey);
    const outcome = this.props.recoveryPublicKey ? 'replaced' : 'registered';
    this.props = {
      ...this.props,
      recoveryPublicKey: key,
      recoveryKeyChangedAt: by.now,
      recoveryKeyChangedByUserId: by.userId,
    };
    return outcome;
  }

  /** A platform-appointed admin: (re)starts the protection window; a new appointment overwrites the previous one. */
  recordPlatformAppointment(userId: string, now: Date): void {
    this.props = {
      ...this.props,
      platformAppointment: {
        appointedUserId: userId,
        appointedAt: now,
        protectedUntil: new Date(
          now.getTime() + PLATFORM_APPOINTMENT_PROTECTION_DAYS * DAY_MS,
        ),
      },
    };
  }

  isUnderProtection(now: Date): boolean {
    const until = this.props.platformAppointment?.protectedUntil;
    return until !== undefined && now.getTime() < until.getTime();
  }

  /** 422 `organization-under-protection` (with `protectedUntil`) while the window lasts; no early lift. */
  assertNotUnderProtection(now: Date): void {
    const appointment = this.props.platformAppointment;
    if (appointment && this.isUnderProtection(now)) {
      throw new DomainValidationError(
        'organization-under-protection',
        'The organization is under protection after a platform-appointed admin: the recovery key cannot change and members cannot be removed until protectedUntil.',
        { protectedUntil: appointment.protectedUntil.toISOString() },
      );
    }
  }

  /** The appointment members see: until `PLATFORM_APPOINTMENT_NOTICE_DAYS` after the window ends, then null. */
  platformAppointmentNotice(now: Date): PlatformAppointment | null {
    const appointment = this.props.platformAppointment;
    if (!appointment) return null;
    const visibleUntil =
      appointment.protectedUntil.getTime() +
      PLATFORM_APPOINTMENT_NOTICE_DAYS * DAY_MS;
    return now.getTime() < visibleUntil ? { ...appointment } : null;
  }

  isPersonalOwner(userId: string): boolean {
    return (
      this.props.personalOwnerUserId !== null &&
      this.props.personalOwnerUserId === userId
    );
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
  get recoveryKeyChangedAt(): Date | null {
    return this.props.recoveryKeyChangedAt;
  }
  get recoveryKeyChangedByUserId(): string | null {
    return this.props.recoveryKeyChangedByUserId;
  }
  get platformAppointment(): PlatformAppointment | null {
    return this.props.platformAppointment
      ? { ...this.props.platformAppointment }
      : null;
  }
  get hubLinkPolicy(): HubLinkPolicy {
    return this.props.hubLinkPolicy;
  }
  get allowRoomSpaces(): boolean {
    return this.props.allowRoomSpaces;
  }
  get storageQuotaBytes(): number {
    return this.props.storageQuotaBytes;
  }
  get aiBudgetMicroUsd(): bigint {
    return this.props.aiBudgetMicroUsd;
  }
  get createdAt(): Date | undefined {
    return this.props.createdAt;
  }
  get updatedAt(): Date | undefined {
    return this.props.updatedAt;
  }
}
