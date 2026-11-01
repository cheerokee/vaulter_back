import {
  MEMBER,
  ORG_ID,
  STRANGER,
  makeKit,
  makeOrganization,
} from '../../../test/support/organizations-kit.js';
import { OrganizationDirectory } from './organization-directory.js';

const kit = makeKit();
const d = kit.deps;
beforeEach(() => {
  vi.resetAllMocks();
  kit.reset();
});
const directory = () => new OrganizationDirectory(d.memberships, d.orgs);

describe('OrganizationDirectory', () => {
  it('isActiveMember: true for a member, false for a stranger or a malformed id', async () => {
    await expect(directory().isActiveMember(ORG_ID, MEMBER)).resolves.toBe(
      true,
    );
    await expect(directory().isActiveMember(ORG_ID, STRANGER)).resolves.toBe(
      false,
    );
    await expect(directory().isActiveMember('nope', MEMBER)).resolves.toBe(
      false,
    );
  });

  it('isActiveMember: a malformed userId is false without querying (no 22P02)', async () => {
    await expect(directory().isActiveMember(ORG_ID, 'nope')).resolves.toBe(
      false,
    );
    expect(kit.mocks.memberships.find).not.toHaveBeenCalled();
  });

  it('lockActiveMember: locks through the repository; malformed ids are false without a query', async () => {
    await expect(directory().lockActiveMember(ORG_ID, MEMBER)).resolves.toBe(
      true,
    );
    expect(kit.mocks.memberships.lockActive).toHaveBeenCalledWith(
      ORG_ID,
      MEMBER,
    );
    await expect(directory().lockActiveMember(ORG_ID, STRANGER)).resolves.toBe(
      false,
    );
    kit.mocks.memberships.lockActive.mockClear();
    await expect(directory().lockActiveMember('nope', MEMBER)).resolves.toBe(
      false,
    );
    await expect(directory().lockActiveMember(ORG_ID, 'nope')).resolves.toBe(
      false,
    );
    expect(kit.mocks.memberships.lockActive).not.toHaveBeenCalled();
  });

  it('organizationIdsOf: every active organization of the user, across pages', async () => {
    const O2 = '019a1b2c-0000-7000-8000-000000000002';
    kit.mocks.orgs.listForUser
      .mockResolvedValueOnce({
        items: [{ organization: makeOrganization(), roleKey: 'org_admin' }],
        nextCursor: 'c1',
      })
      .mockResolvedValueOnce({
        items: [
          { organization: makeOrganization({}, O2), roleKey: 'org_member' },
        ],
        nextCursor: null,
      });
    await expect(directory().organizationIdsOf(MEMBER)).resolves.toEqual([
      ORG_ID,
      O2,
    ]);
    expect(kit.mocks.orgs.listForUser).toHaveBeenNthCalledWith(2, MEMBER, {
      cursor: 'c1',
      limit: 100,
    });
    await expect(directory().organizationIdsOf('nope')).resolves.toEqual([]);
  });

  it('recoveryPublicKey: null without a key or for an unknown org, the key otherwise', async () => {
    await expect(directory().recoveryPublicKey(ORG_ID)).resolves.toBeNull();
    kit.setOrganization(makeOrganization({ recoveryPublicKey: 'pk-abc' }));
    await expect(directory().recoveryPublicKey(ORG_ID)).resolves.toBe('pk-abc');
    kit.setOrganization(null);
    await expect(directory().recoveryPublicKey(ORG_ID)).resolves.toBeNull();
    await expect(directory().recoveryPublicKey('nope')).resolves.toBeNull();
  });

  it('hubLinkPolicy: the policy, or null for an unknown org or a malformed id', async () => {
    await expect(directory().hubLinkPolicy(ORG_ID)).resolves.toBe(
      'any_member_hub',
    );
    kit.setOrganization(makeOrganization({ hubLinkPolicy: 'admin_approved' }));
    await expect(directory().hubLinkPolicy(ORG_ID)).resolves.toBe(
      'admin_approved',
    );
    kit.setOrganization(null);
    await expect(directory().hubLinkPolicy(ORG_ID)).resolves.toBeNull();
    kit.mocks.orgs.findById.mockClear();
    await expect(directory().hubLinkPolicy('nope')).resolves.toBeNull();
    expect(kit.mocks.orgs.findById).not.toHaveBeenCalled();
  });

  it('allowRoomSpaces: the policy, false for an unknown org or a malformed id', async () => {
    await expect(directory().allowRoomSpaces(ORG_ID)).resolves.toBe(true);
    kit.setOrganization(makeOrganization({ allowRoomSpaces: false }));
    await expect(directory().allowRoomSpaces(ORG_ID)).resolves.toBe(false);
    kit.setOrganization(null);
    await expect(directory().allowRoomSpaces(ORG_ID)).resolves.toBe(false);
    kit.mocks.orgs.findById.mockClear();
    await expect(directory().allowRoomSpaces('nope')).resolves.toBe(false);
    expect(kit.mocks.orgs.findById).not.toHaveBeenCalled();
  });
});
