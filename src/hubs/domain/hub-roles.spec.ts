import { HubRoleRules } from './hub-roles.js';

describe('HubRoleRules', () => {
  it('assigns only hub_operator or hub_user', () => {
    expect(HubRoleRules.assertAssignable('hub_operator')).toBe('hub_operator');
    expect(HubRoleRules.assertAssignable('hub_user')).toBe('hub_user');
    for (const key of ['hub_owner', 'hub_room', 'org_admin', '']) {
      expect(() => HubRoleRules.assertAssignable(key)).toThrow(
        expect.objectContaining({ code: 'role-invalid' }),
      );
    }
  });

  it('protects the owner', () => {
    expect(() => HubRoleRules.assertNotOwner('u1', 'u1')).toThrow(
      expect.objectContaining({ code: 'hub-owner-protected' }),
    );
    expect(() => HubRoleRules.assertNotOwner('u1', 'u2')).not.toThrow();
  });
});
