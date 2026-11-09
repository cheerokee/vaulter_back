// Catálogo fixo dos papéis da plataforma (equipe; spec de papéis da plataforma §4.1). Fonte da verdade em código; a
// migration CreatePlatformRoles grava os mesmos dados e o e2e confere que o banco bate com estas constantes.
// Mudar o catálogo = nova migration.
export const PLATFORM_PERMISSIONS = [
  'platform.roles.manage',
  'platform.support.request',
  'platform.support.approve',
  'platform.support.execute_alone',
  'platform.audit.read',
  'platform.billing.storage_quota',
] as const;

export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

export const PLATFORM_ROLES = {
  platform_admin: {
    name: 'Administrador da plataforma',
    permissions: [...PLATFORM_PERMISSIONS],
  },
  platform_support: {
    name: 'Suporte',
    permissions: ['platform.support.request', 'platform.audit.read'],
  },
  platform_finance: {
    name: 'Financeiro',
    permissions: ['platform.billing.storage_quota'],
  },
} as const satisfies Record<
  string,
  { name: string; permissions: readonly PlatformPermission[] }
>;

export type PlatformRoleKey = keyof typeof PLATFORM_ROLES;

export function isPlatformRoleKey(s: string): s is PlatformRoleKey {
  return Object.hasOwn(PLATFORM_ROLES, s);
}
