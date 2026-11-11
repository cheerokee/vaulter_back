import { DomainValidationError } from '../../shared/domain/errors.js';

/**
 * A published version of the active-cloud term (spec active-cloud §4.1): pt-BR text, with the SHA-256 of its UTF-8
 * bytes (hex) so an acceptance names exactly the text that was shown. Published only by migration (immutable for the
 * runtime); the current term is the highest version.
 */
export type CloudTerm = {
  version: number;
  /** SHA-256 of the UTF-8 text, 64 lowercase hex chars. */
  hash: string;
  text: string;
  publishedAt: Date;
};

/** An organization accepted one term version (once per version; whoever decides for the organization). */
export type CloudTermAcceptance = {
  organizationId: string;
  termVersion: number;
  termHash: string;
  acceptedByUserId: string;
  acceptedAt: Date;
};

export const CloudTermRules = {
  /**
   * Accepting: the version AND the hash the app showed must be the current term's. A stale screen (a newer term was
   * published meanwhile) gets 422 `cloud-terms-outdated` with the current version, to reload and show it again.
   */
  assertAcceptsCurrent(
    current: CloudTerm | null,
    version: number,
    hash: string,
  ): CloudTerm {
    if (!current || current.version !== version || current.hash !== hash) {
      throw new DomainValidationError(
        'cloud-terms-outdated',
        'The term shown is not the current one; reload it and accept again.',
        current ? { currentVersion: current.version } : undefined,
      );
    }
    return current;
  },

  /**
   * Authorizing or switching on a space needs the organization's acceptance of the CURRENT term (a new version must
   * be accepted again before a new space; spaces already on stay on). 422 `cloud-terms-not-accepted`.
   */
  assertCurrentAccepted(
    current: CloudTerm | null,
    accepted: CloudTermAcceptance | null,
  ): CloudTerm {
    if (!current || !accepted || accepted.termVersion !== current.version) {
      throw new DomainValidationError(
        'cloud-terms-not-accepted',
        'The organization must accept the current active-cloud term first.',
        current ? { currentVersion: current.version } : undefined,
      );
    }
    return current;
  },
};
