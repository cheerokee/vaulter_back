import { HubOrganizationLink } from './hub-organization-link.js';

const now = new Date('2026-11-01T12:00:00Z');
const later = new Date('2026-11-01T13:00:00Z');
const base = { hubId: 'h', organizationId: 'o', now };

describe('HubOrganizationLink', () => {
  describe('ownerLinks', () => {
    it('is approved at once under any_member_hub', () => {
      const l = HubOrganizationLink.ownerLinks({
        ...base,
        userId: 'owner',
        policy: 'any_member_hub',
      });
      expect(l.status).toBe('approved');
      expect(l.isActive).toBe(true);
      expect(l.ownerApprovedByUserId).toBe('owner');
      expect(l.orgApprovedAt).toEqual(now);
      expect(l.orgApprovedByUserId).toBeNull();
    });

    it('waits for an admin under admin_approved', () => {
      const l = HubOrganizationLink.ownerLinks({
        ...base,
        userId: 'owner',
        policy: 'admin_approved',
      });
      expect(l.status).toBe('pending');
      expect(l.isActive).toBe(false);
      expect(l.ownerApprovedAt).toEqual(now);
      expect(l.orgApprovedAt).toBeNull();
      l.approveAsOrgAdmin('admin', later);
      expect(l.status).toBe('approved');
      expect(l.orgApprovedByUserId).toBe('admin');
    });
  });

  describe('requestByOther', () => {
    it('waits for the owner under any_member_hub', () => {
      const l = HubOrganizationLink.requestByOther({
        ...base,
        userId: 'ana',
        policy: 'any_member_hub',
      });
      expect(l.status).toBe('pending');
      expect(l.requestedByUserId).toBe('ana');
      l.approveAsOwner('owner', later);
      expect(l.status).toBe('approved');
      expect(l.ownerApprovedByUserId).toBe('owner');
    });

    it('needs the owner and an admin under admin_approved, in any order', () => {
      const a = HubOrganizationLink.requestByOther({
        ...base,
        userId: 'ana',
        policy: 'admin_approved',
      });
      a.approveAsOwner('owner', later);
      expect(a.status).toBe('pending');
      a.approveAsOrgAdmin('admin', later);
      expect(a.status).toBe('approved');

      const b = HubOrganizationLink.requestByOther({
        ...base,
        userId: 'ana',
        policy: 'admin_approved',
      });
      b.approveAsOrgAdmin('admin', later);
      expect(b.status).toBe('pending');
      b.approveAsOwner('owner', later);
      expect(b.status).toBe('approved');
    });
  });

  it('rejects only pending links', () => {
    const l = HubOrganizationLink.requestByOther({
      ...base,
      userId: 'ana',
      policy: 'admin_approved',
    });
    l.reject();
    expect(l.status).toBe('rejected');
    expect(() => l.reject()).toThrow(
      expect.objectContaining({ code: 'link-not-pending' }),
    );
    expect(() => l.approveAsOwner('o', later)).toThrow(
      expect.objectContaining({ code: 'link-not-pending' }),
    );
    expect(() => l.approveAsOrgAdmin('a', later)).toThrow(
      expect.objectContaining({ code: 'link-not-pending' }),
    );
  });

  it('cannot approve an already approved link', () => {
    const l = HubOrganizationLink.ownerLinks({
      ...base,
      userId: 'owner',
      policy: 'any_member_hub',
    });
    expect(() => l.approveAsOwner('owner', later)).toThrow(
      expect.objectContaining({ code: 'link-not-pending' }),
    );
  });

  it('revokes approved or pending, not rejected or revoked', () => {
    const l = HubOrganizationLink.ownerLinks({
      ...base,
      userId: 'owner',
      policy: 'any_member_hub',
    });
    l.revoke();
    expect(l.status).toBe('revoked');
    expect(l.isActive).toBe(false);
    expect(() => l.revoke()).toThrow(
      expect.objectContaining({ code: 'link-not-active' }),
    );
    const p = HubOrganizationLink.requestByOther({
      ...base,
      userId: 'ana',
      policy: 'admin_approved',
    });
    p.revoke();
    expect(p.status).toBe('revoked');
  });

  it('refuses a new request while linked or pending', () => {
    const approved = HubOrganizationLink.ownerLinks({
      ...base,
      userId: 'owner',
      policy: 'any_member_hub',
    });
    expect(() =>
      HubOrganizationLink.requestByOther({
        ...base,
        userId: 'ana',
        policy: 'any_member_hub',
        existing: approved,
      }),
    ).toThrow(expect.objectContaining({ code: 'already-linked' }));
    const pending = HubOrganizationLink.requestByOther({
      ...base,
      userId: 'ana',
      policy: 'admin_approved',
    });
    expect(() =>
      HubOrganizationLink.ownerLinks({
        ...base,
        userId: 'owner',
        policy: 'any_member_hub',
        existing: pending,
      }),
    ).toThrow(expect.objectContaining({ code: 'already-linked' }));
  });

  it('restarts from a rejected or revoked link keeping id and creation date', () => {
    const old = HubOrganizationLink.ownerLinks({
      ...base,
      userId: 'owner',
      policy: 'any_member_hub',
    });
    old.revoke();
    const again = HubOrganizationLink.requestByOther({
      ...base,
      now: later,
      userId: 'ana',
      policy: 'admin_approved',
      existing: old,
    });
    expect(again.id).toBe(old.id);
    expect(again.createdAt).toEqual(now);
    expect(again.status).toBe('pending');
    expect(again.requestedByUserId).toBe('ana');
    expect(again.ownerApprovedAt).toBeNull();
    expect(again.orgApprovedAt).toBeNull();
  });
});
