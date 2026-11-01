import { ConflictError } from '../../shared/domain/errors.js';
import { Entity } from '../../shared/domain/entity.js';

export const LINK_CODE_TTL_MS = 10 * 60 * 1000;

export type LinkCodeProps = {
  hubId: string;
  codeHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt?: Date;
};

export class LinkCode extends Entity<LinkCodeProps> {
  static issue(input: {
    hubId: string;
    codeHash: string;
    now: Date;
  }): LinkCode {
    return new LinkCode({
      hubId: input.hubId,
      codeHash: input.codeHash,
      expiresAt: new Date(input.now.getTime() + LINK_CODE_TTL_MS),
      usedAt: null,
      createdAt: input.now,
    });
  }

  static restore(props: LinkCodeProps, id: string): LinkCode {
    return new LinkCode(props, id);
  }

  get hubId(): string {
    return this.props.hubId;
  }
  get codeHash(): string {
    return this.props.codeHash;
  }
  get expiresAt(): Date {
    return this.props.expiresAt;
  }
  get usedAt(): Date | null {
    return this.props.usedAt;
  }

  /** Single use; expired and used are the same error. */
  consume(now: Date): void {
    if (
      this.props.usedAt !== null ||
      now.getTime() >= this.props.expiresAt.getTime()
    ) {
      throw new ConflictError(
        'link-code-invalid',
        'The link code is invalid or expired.',
      );
    }
    this.props = { ...this.props, usedAt: now };
  }
}
