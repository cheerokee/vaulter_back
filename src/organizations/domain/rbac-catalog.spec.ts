import {
  FACTORY_ROLES,
  PERMISSIONS,
  PERMISSION_DEPENDENCIES,
} from './rbac-catalog.js';

const HUB_ALL = [
  'chat.voice',
  'chat.live',
  'camera.view',
  'camera.live',
  'nodes.view',
  'nodes.control',
  'mesh.dispatch',
  'hub.settings',
];

describe('RBAC catalog', () => {
  it('has the 16 permissions with their scopes', () => {
    expect(Object.keys(PERMISSIONS)).toHaveLength(16);
    const byScope = (scope: string) =>
      Object.entries(PERMISSIONS)
        .filter(([, s]) => s === scope)
        .map(([k]) => k);
    expect(byScope('space')).toEqual([
      'memory.read',
      'memory.write',
      'memory.delete',
      'space.members.manage',
    ]);
    expect(byScope('hub')).toEqual(HUB_ALL);
    expect(byScope('organization')).toEqual([
      'org.members.manage',
      'org.spaces.create',
      'org.hubs.approve',
      'org.billing',
    ]);
  });

  it('matches the design table of factory roles', () => {
    expect(FACTORY_ROLES).toEqual({
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
      hub_owner: HUB_ALL,
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
    });
  });

  it('declares the dependencies', () => {
    expect(PERMISSION_DEPENDENCIES).toEqual({
      'camera.live': 'camera.view',
      'nodes.control': 'nodes.view',
    });
  });

  it('keeps every role closed under the dependencies', () => {
    for (const perms of Object.values(FACTORY_ROLES)) {
      for (const p of perms) {
        const req =
          PERMISSION_DEPENDENCIES[p as keyof typeof PERMISSION_DEPENDENCIES];
        if (req) expect(perms).toContain(req);
      }
    }
  });
});
