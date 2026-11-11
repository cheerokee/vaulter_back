import { v5 } from 'uuid';

/**
 * Fixed `objectId`s of the two manifests of a space's backup (contract in `docs/hubs/space-manifest.md`): UUID v5 with
 * the space id as namespace and a label without the product name. Anyone who knows the space id can derive them,
 * which reveals nothing new (the bucket key already carries the space id).
 *
 * - the Hub manifest (`space-manifest/hub`): written by the Hub (or a member's app) like any other backup object;
 * - the cloud manifest (`space-manifest/cloud`): written ONLY by the server (active cloud); the backup routes refuse it
 *   for Hubs and people (`object-id-reserved`).
 *
 * In `shared/domain` because `storage` (reserves the cloud one) and `cloud` (reads both) need the same derivation and
 * neither imports the other.
 */
export const HUB_MANIFEST_LABEL = 'space-manifest/hub';
export const CLOUD_MANIFEST_LABEL = 'space-manifest/cloud';

export function hubManifestObjectId(spaceId: string): string {
  return v5(HUB_MANIFEST_LABEL, spaceId);
}

export function cloudManifestObjectId(spaceId: string): string {
  return v5(CLOUD_MANIFEST_LABEL, spaceId);
}
