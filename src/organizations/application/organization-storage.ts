// A regra da franquia, exportada da application/ para os outros módulos (o `spaces` confere ao criar ou aumentar um
// espaço, com o retrato travado de `OrganizationDirectory.lockStorageQuota`).
export {
  assertStorageQuotaFits as assertOrganizationStorageFits,
  type OrganizationStorageQuota,
} from '../domain/storage-quota.js';
