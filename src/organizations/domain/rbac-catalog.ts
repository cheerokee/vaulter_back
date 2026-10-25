// Catálogo fixo de RBAC (spec de organizações §6). Fonte da verdade em código; a migration grava os mesmos
// dados e o e2e confere que o banco bate com estas constantes.
export type PermissionScope = 'organization' | 'space' | 'hub';

export const PERMISSIONS = {
  'memory.read': 'space',
  'memory.write': 'space',
  'memory.delete': 'space',
  'space.members.manage': 'space',
  'chat.voice': 'hub',
  'chat.live': 'hub',
  'camera.view': 'hub',
  'camera.live': 'hub',
  'nodes.view': 'hub',
  'nodes.control': 'hub',
  'mesh.dispatch': 'hub',
  'hub.settings': 'hub',
  'org.members.manage': 'organization',
  'org.spaces.create': 'organization',
  'org.hubs.approve': 'organization',
  'org.billing': 'organization',
} as const satisfies Record<string, PermissionScope>;

export type PermissionKey = keyof typeof PERMISSIONS;

// permissão -> a que ela exige
export const PERMISSION_DEPENDENCIES = {
  'camera.live': 'camera.view',
  'nodes.control': 'nodes.view',
} as const satisfies Partial<Record<PermissionKey, PermissionKey>>;

export const FACTORY_ROLES = {
  org_admin: [
    'org.members.manage',
    'org.spaces.create',
    'org.hubs.approve',
    'org.billing',
  ],
  org_member: [],
  space_reader: ['memory.read'],
  space_editor: ['memory.read', 'memory.write'],
  space_manager: [
    'memory.read',
    'memory.write',
    'memory.delete',
    'space.members.manage',
  ],
  hub_owner: [
    'chat.voice',
    'chat.live',
    'camera.view',
    'camera.live',
    'nodes.view',
    'nodes.control',
    'mesh.dispatch',
    'hub.settings',
  ],
  hub_operator: [
    'chat.voice',
    'chat.live',
    'camera.view',
    'camera.live',
    'nodes.view',
    'nodes.control',
    'mesh.dispatch',
  ],
  hub_user: ['chat.voice', 'chat.live', 'nodes.view'],
  hub_room: ['chat.voice'],
} as const satisfies Record<string, readonly PermissionKey[]>;

export type FactoryRoleKey = keyof typeof FACTORY_ROLES;
