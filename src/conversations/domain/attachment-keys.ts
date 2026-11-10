// Caminhos dos anexos no bucket do storage (spec conversations §4.4): só ids, nunca nome ou tipo de arquivo.

/** Final object: `orgs/<orgId>/spaces/<spaceId>/conversations/<conversationId>/<attachmentId>` (one version only). */
export function attachmentKey(a: {
  organizationId: string;
  spaceId: string;
  conversationId: string;
  id: string;
}): string {
  return `orgs/${a.organizationId}/spaces/${a.spaceId}/conversations/${a.conversationId}/${a.id}`;
}

/**
 * Provisional upload (presigned PUT, tag `stage=upload`: expires in 1 day by the bucket lifecycle):
 * `.../conversations/<conversationId>/uploads/<attachmentId>`. Never the backup's `uploads/` prefix (its ids are the
 * server's, these are the device's).
 */
export function attachmentUploadKey(a: {
  organizationId: string;
  spaceId: string;
  conversationId: string;
  id: string;
}): string {
  return `orgs/${a.organizationId}/spaces/${a.spaceId}/conversations/${a.conversationId}/uploads/${a.id}`;
}
