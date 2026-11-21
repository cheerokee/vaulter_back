import { NotFoundError } from '../../shared/domain/errors.js';
import { HubAccess } from '../../hubs/application/hub-access.js';
import { HubDirectory } from '../../hubs/application/hub-directory.js';

/** 404 `hub-not-found`, the same answer for a hub that is not yours, not a `pc` or does not exist. */
export const pcHubNotFound = () =>
  new NotFoundError('hub-not-found', 'The hub was not found.');

/**
 * The `pc` hub of the owner: `HubAccess.requireOwner` (404 for whoever cannot see the hub; a pc is seen by its owner
 * only), then the kind, so an appliance of the owner is the same 404 (it has no catalog to read).
 */
export async function requireOwnedPcHub(
  access: HubAccess,
  directory: HubDirectory,
  hubId: string,
  userId: string,
): Promise<void> {
  await access.requireOwner(hubId, userId);
  if ((await directory.kindOf(hubId)) !== 'pc') throw pcHubNotFound();
}
