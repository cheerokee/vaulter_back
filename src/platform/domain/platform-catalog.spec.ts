import {
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLES,
  isPlatformRoleKey,
} from './platform-catalog.js';

describe('platform catalog', () => {
  it('has the six platform permissions', () => {
    expect([...PLATFORM_PERMISSIONS].sort()).toEqual(
      [
        'platform.audit.read',
        'platform.billing.storage_quota',
        'platform.roles.manage',
        'platform.support.approve',
        'platform.support.execute_alone',
        'platform.support.request',
      ].sort(),
    );
  });

  it('platform_admin has every permission', () => {
    expect([...PLATFORM_ROLES.platform_admin.permissions].sort()).toEqual(
      [...PLATFORM_PERMISSIONS].sort(),
    );
  });

  it('platform_support has exactly request and audit read', () => {
    expect([...PLATFORM_ROLES.platform_support.permissions].sort()).toEqual([
      'platform.audit.read',
      'platform.support.request',
    ]);
  });

  it('platform_finance has only the storage quota permission', () => {
    expect(PLATFORM_ROLES.platform_finance.permissions).toEqual([
      'platform.billing.storage_quota',
    ]);
  });

  it('every role has a display name and only known permissions', () => {
    for (const role of Object.values(PLATFORM_ROLES)) {
      expect(role.name.length).toBeGreaterThan(0);
      for (const p of role.permissions) {
        expect(PLATFORM_PERMISSIONS).toContain(p);
      }
    }
  });

  it('recognizes platform role keys', () => {
    expect(isPlatformRoleKey('platform_admin')).toBe(true);
    expect(isPlatformRoleKey('platform_finance')).toBe(true);
    expect(isPlatformRoleKey('org_admin')).toBe(false);
    expect(isPlatformRoleKey('toString')).toBe(false);
  });
});
