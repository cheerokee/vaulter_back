import {
  ConflictError,
  DomainValidationError,
} from '../../shared/domain/errors.js';
import { Entity } from '../../shared/domain/entity.js';

export type SpaceActivationState = 'authorized' | 'active';

export type SpaceActivationProps = {
  organizationId: string;
  spaceId: string;
  state: SpaceActivationState;
  /** The term version the organization had accepted when the space was authorized. */
  termVersion: number;
  authorizedByUserId: string;
  authorizedAt: Date;
  activatedByUserId: string | null;
  activatedAt: Date | null;
};

/**
 * One cycle of the active cloud for a space (spec active-cloud §4.1), in two steps: whoever decides for the
 * organization AUTHORIZES (`authorized`: waiting for the key) and the space manager, who has the key, sends the server
 * copy of every version and SWITCHES IT ON (`active`). Switching off ends the cycle (tombstone; a later authorization
 * starts a new row, so the history of who authorized/activated stays).
 */
export class SpaceActivation extends Entity<SpaceActivationProps> {
  static authorize(input: {
    organizationId: string;
    spaceId: string;
    termVersion: number;
    byUserId: string;
    at: Date;
  }): SpaceActivation {
    return new SpaceActivation({
      organizationId: input.organizationId,
      spaceId: input.spaceId,
      state: 'authorized',
      termVersion: input.termVersion,
      authorizedByUserId: input.byUserId,
      authorizedAt: input.at,
      activatedByUserId: null,
      activatedAt: null,
    });
  }

  static restore(props: SpaceActivationProps, id: string): SpaceActivation {
    return new SpaceActivation(props, id);
  }

  /** `authorized` -> `active`. Already on: 409 `cloud-already-active`. */
  activate(byUserId: string, at: Date): void {
    if (this.props.state === 'active') {
      throw new ConflictError(
        'cloud-already-active',
        'The active cloud is already on for this space.',
      );
    }
    this.props = {
      ...this.props,
      state: 'active',
      activatedByUserId: byUserId,
      activatedAt: at,
    };
  }

  get organizationId(): string {
    return this.props.organizationId;
  }
  get spaceId(): string {
    return this.props.spaceId;
  }
  get state(): SpaceActivationState {
    return this.props.state;
  }
  get termVersion(): number {
    return this.props.termVersion;
  }
  get authorizedByUserId(): string {
    return this.props.authorizedByUserId;
  }
  get authorizedAt(): Date {
    return this.props.authorizedAt;
  }
  get activatedByUserId(): string | null {
    return this.props.activatedByUserId;
  }
  get activatedAt(): Date | null {
    return this.props.activatedAt;
  }
}

function sortedUnique(xs: readonly number[]): number[] {
  return [...new Set(xs)].sort((a, b) => a - b);
}

export const SpaceActivationRules = {
  /**
   * Authorizing: the space allows an online language model (`allow_online_llm`, spec §3) and has someone to send
   * the key (an orphan space can never be switched on). The AI budget check (> 0) joins here in Task 5.
   */
  assertCanAuthorize(input: {
    allowOnlineLlm: boolean;
    memberCount: number;
  }): void {
    if (!input.allowOnlineLlm) {
      throw new DomainValidationError(
        'online-llm-not-allowed',
        'The space does not allow an online language model.',
      );
    }
    if (input.memberCount === 0) {
      throw new DomainValidationError(
        'space-orphaned',
        'The space has no members: nobody can send its key to the server.',
      );
    }
  },

  /** Switching on needs the authorization first: 422 `cloud-not-authorized`. */
  assertAuthorized(activation: SpaceActivation | null): SpaceActivation {
    if (!activation) {
      throw new DomainValidationError(
        'cloud-not-authorized',
        'The active cloud has not been authorized for this space.',
      );
    }
    return activation;
  },

  /**
   * Switching on: one server copy per existing key version (1..current), no duplicates, none missing or extra. The
   * 409 `key-versions-mismatch` carries the same details as adding a member to the space.
   */
  assertCoversVersions(
    sentVersions: readonly number[],
    existingVersions: readonly number[],
  ): void {
    const sent = new Set(sentVersions);
    const expected = new Set(existingVersions);
    const duplicated = sentVersions.filter(
      (v, i) => sentVersions.indexOf(v) !== i,
    );
    const missing = [...expected].filter((v) => !sent.has(v));
    const unexpected = [...sent].filter((v) => !expected.has(v));
    if (missing.length || unexpected.length || duplicated.length) {
      throw new ConflictError(
        'key-versions-mismatch',
        'The server copies must cover every existing key version of the space.',
        {
          expectedVersions: sortedUnique(existingVersions),
          missingVersions: sortedUnique(missing),
          unexpectedVersions: sortedUnique(unexpected),
          duplicatedVersions: sortedUnique(duplicated),
        },
      );
    }
  },
};
