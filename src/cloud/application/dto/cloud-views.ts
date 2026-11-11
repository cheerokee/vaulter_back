import type {
  CloudTerm,
  CloudTermAcceptance,
} from '../../domain/cloud-term.js';
import type { SpaceActivation } from '../../domain/space-activation.js';

/** The current term and the organization's latest acceptance (`accepted.version` < `current.version`: accept again). */
export type CloudTermsView = {
  current: CloudTerm | null;
  accepted: {
    version: number;
    hash: string;
    acceptedAt: Date;
    acceptedByUserId: string;
  } | null;
};

export function toAcceptanceView(
  a: CloudTermAcceptance,
): NonNullable<CloudTermsView['accepted']> {
  return {
    version: a.termVersion,
    hash: a.termHash,
    acceptedAt: a.acceptedAt,
    acceptedByUserId: a.acceptedByUserId,
  };
}

/** `off`: no live cycle; `authorized`: waiting for the manager's key; `active`: the server reads the space. */
export type SpaceCloudStateView = {
  spaceId: string;
  state: 'off' | 'authorized' | 'active';
  termVersion: number | null;
  authorizedAt: Date | null;
  authorizedByUserId: string | null;
  activatedAt: Date | null;
  activatedByUserId: string | null;
};

export function toSpaceCloudStateView(
  spaceId: string,
  a: SpaceActivation | null,
): SpaceCloudStateView {
  return {
    spaceId,
    state: a?.state ?? 'off',
    termVersion: a?.termVersion ?? null,
    authorizedAt: a?.authorizedAt ?? null,
    authorizedByUserId: a?.authorizedByUserId ?? null,
    activatedAt: a?.activatedAt ?? null,
    activatedByUserId: a?.activatedByUserId ?? null,
  };
}
