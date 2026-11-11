import { ConflictError } from '../../shared/domain/errors.js';

/**
 * Precondition of a server write to the backup (`ServerBackupWriter`), checked in BOTH of its transactions right after
 * the space row is locked (so the answer cannot change until the commit): e.g. "the space is still in the active
 * cloud". False = nothing is written (`ServerWriteRefusedError`).
 */
export type BackupWriteGuard = (space: {
  organizationId: string;
  spaceId: string;
}) => Promise<boolean>;

/** The guard of a server write said no (e.g. the space left the active cloud meanwhile): nothing was written. */
export class ServerWriteRefusedError extends ConflictError {
  constructor() {
    super('server-write-refused', 'The server write is no longer allowed.');
  }
}
