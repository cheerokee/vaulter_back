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

  it('recoveryPublicKey: null without a key or for an unknown org, the key otherwise', async () => {
    await expect(directory().recoveryPublicKey(ORG_ID)).resolves.toBeNull();
    kit.setOrganization(makeOrganization({ recoveryPublicKey: 'pk-abc' }));
    await expect(directory().recoveryPublicKey(ORG_ID)).resolves.toBe('pk-abc');
    kit.setOrganization(null);
    await expect(directory().recoveryPublicKey(ORG_ID)).resolves.toBeNull();
    await expect(directory().recoveryPublicKey('nope')).resolves.toBeNull();
  });
});
