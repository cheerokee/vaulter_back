import { Injectable } from '@nestjs/common';
import { ServerKeyGrantRepository } from '../../domain/cloud.repositories.js';
import { ServerKeyring } from '../ports/server-keyring.js';

/** The space has no server copy of a key version its backup uses (it should not happen in `active_cloud`). */
export class MissingServerCopyError extends Error {
  constructor(readonly keyVersion: number) {
    super(`no server copy of space key version ${keyVersion}`);
    this.name = 'MissingServerCopyError';
  }
}

/**
 * The opened keys of one space for one job: each version opened on first use (`ServerKeyring.openSealed`, in memory
 * only) and every one of them wiped by `wipe()` (call it in a `finally`). Never logged, never returned to anyone else.
 */
export class SpaceKeys {
  private readonly opened = new Map<number, Uint8Array>();

  constructor(
    private readonly copies: ReadonlyMap<number, string>,
    private readonly keyring: ServerKeyring,
  ) {}

  async get(keyVersion: number): Promise<Uint8Array> {
    const hit = this.opened.get(keyVersion);
    if (hit) return hit;
    const copy = this.copies.get(keyVersion);
    if (!copy) throw new MissingServerCopyError(keyVersion);
    const key = await this.keyring.openSealed(copy);
    this.opened.set(keyVersion, key);
    return key;
  }

  wipe(): void {
    for (const key of this.opened.values()) key.fill(0);
    this.opened.clear();
  }
}

@Injectable()
export class SpaceKeyOpener {
  constructor(
    private readonly grants: ServerKeyGrantRepository,
    private readonly keyring: ServerKeyring,
  ) {}

  /** The server copies of every version of the space, ready to open on demand. */
  async forSpace(organizationId: string, spaceId: string): Promise<SpaceKeys> {
    const copies = await this.grants.findForSpace(organizationId, spaceId);
    return new SpaceKeys(
      new Map(copies.map((c) => [c.keyVersion, c.wrappedKey])),
      this.keyring,
    );
  }
}
