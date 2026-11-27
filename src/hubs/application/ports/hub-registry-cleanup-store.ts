/** The registry tables of the hubs that keep only short-lived rows (enrollments, link codes, auth challenges). */
export type HubRegistryTable =
  'hub_enrollments' | 'hub_link_codes' | 'hub_auth_challenges';

/**
 * Physical cleanup of the hub registry tables (a documented exception to the soft delete: these rows never sync and the
 * runtime had no DELETE). The implementation runs in the trusted context `app.hub_registry_cleanup` (migration
 * MaintenanceTrustedContexts), where the only DELETE policy opens the rows expired more than
 * `HUB_REGISTRY_RETENTION_DAYS` ago.
 */
export abstract class HubRegistryCleanupStore {
  /** Deletes up to `limit` rows of `table` expired past the window, in a short transaction of its own; returns how many. */
  abstract deleteExpired(
    table: HubRegistryTable,
    limit: number,
  ): Promise<number>;
}
