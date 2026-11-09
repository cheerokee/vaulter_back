// Caminhos no bucket (`S3_BUCKET_HUB_BRAIN`): só ids, nunca nome de arquivo.

/** Provisional upload (expires in 1 day): `orgs/<orgId>/spaces/<spaceId>/uploads/<uploadId>`. */
export function uploadKey(
  organizationId: string,
  spaceId: string,
  uploadId: string,
): string {
  return `orgs/${organizationId}/spaces/${spaceId}/uploads/${uploadId}`;
}

/** Final object (old versions and delete markers expire in 30 days): `.../objects/<objectId>`. */
export function objectKey(
  organizationId: string,
  spaceId: string,
  objectId: string,
): string {
  return `orgs/${organizationId}/spaces/${spaceId}/objects/${objectId}`;
}
