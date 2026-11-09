/** The authenticated Hub of a request (set by the hub token guard of the `hubs` module, read by `@CurrentHub()`). */
export type HubAuthContext = { hubId: string };
