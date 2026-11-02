import { encodeCursor } from '../../shared/domain/pagination.js';
import type { OrganizationAccess } from '../../organizations/application/organization-access.js';
import type { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import type { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { HubOrganizationRepository } from '../domain/hub-organization.repository.js';
import type { HubSpaceRef } from '../domain/hub-space.repository.js';
import type { HubSpaceRepository } from '../domain/hub-space.repository.js';
import type { HubAccess } from './hub-access.js';
import { ListHubLinksUseCase } from './list-hub-links.use-case.js';
import { ListHubSpacesUseCase } from './list-hub-spaces.use-case.js';

const HUB = '019a0000-0000-7000-8000-0000000000aa';
const USER = '019a0000-0000-7000-8000-0000000000b1';
const org = (n: number) =>
  `019a0000-0000-7000-8000-00000000c${n.toString().padStart(3, '0')}`;
const space = (n: number) =>
  `019a0000-0000-7000-8000-00000000d${n.toString().padStart(3, '0')}`;
const actor = { userId: USER, sessionId: 's' };

const access = { find: vi.fn(), requireAccess: vi.fn() };
const orgAccess = { hasPermission: vi.fn() };
const directory = { organizationIdsOf: vi.fn() };
const links = { list: vi.fn(), findInOrganization: vi.fn() };
const hubSpaces = { list: vi.fn(), listInOrganization: vi.fn() };
const uow = {
  withContext: vi.fn((_ctx: unknown, work: () => Promise<unknown>) => work()),
};
const linkOf = (orgId: string) => ({
  hubId: HUB,
  organizationId: orgId,
  status: 'pending',
  requestedByUserId: USER,
  ownerApprovedAt: null,
  orgApprovedAt: null,
  createdAt: null,
});
const listLinks = () =>
  new ListHubLinksUseCase(
    access as unknown as HubAccess,
    orgAccess as unknown as OrganizationAccess,
    directory as unknown as OrganizationDirectory,
    links as unknown as HubOrganizationRepository,
    uow as unknown as UnitOfWork,
  );
const listSpaces = () =>
  new ListHubSpacesUseCase(
    access as unknown as HubAccess,
    directory as unknown as OrganizationDirectory,
    hubSpaces as unknown as HubSpaceRepository,
    uow as unknown as UnitOfWork,
  );

beforeEach(() => vi.clearAllMocks());

describe('ListHubLinksUseCase (cursor pagination)', () => {
  it('owner: asks the repository for limit + 1 links after the cursor, and returns the next cursor', async () => {
    access.find.mockResolvedValue({ role: 'hub_owner' });
    links.list.mockResolvedValue([org(2), org(3), org(4)].map(linkOf));
    const page = await listLinks().execute(actor, HUB, {
      cursor: encodeCursor(org(1)),
      limit: 2,
    });
    expect(links.list).toHaveBeenCalledWith(HUB, { after: org(1), limit: 3 });
    expect(page.items.map((l) => l.organizationId)).toEqual([org(2), org(3)]);
    expect(page.nextCursor).toBe(encodeCursor(org(3)));
  });

  it('admin: pages over the administered orgs in id order, whatever order the directory returns', async () => {
    access.find.mockResolvedValue(null);
    directory.organizationIdsOf.mockResolvedValue([
      org(5),
      org(1),
      org(3),
      org(2),
    ]);
    orgAccess.hasPermission.mockImplementation(
      async (orgId: string) => orgId !== org(2),
    );
    links.findInOrganization.mockImplementation(
      async (_h: string, orgId: string) => linkOf(orgId),
    );
    const first = await listLinks().execute(actor, HUB, { limit: 2 });
    expect(first.items.map((l) => l.organizationId)).toEqual([org(1), org(3)]);
    const second = await listLinks().execute(actor, HUB, {
      cursor: first.nextCursor!,
      limit: 2,
    });
    expect(second.items.map((l) => l.organizationId)).toEqual([org(5)]);
    expect(second.nextCursor).toBeNull();
  });

  it('admin past the last page: an empty 200 page, not a 403 (authorization ignores the cursor)', async () => {
    access.find.mockResolvedValue({ role: 'hub_user' });
    directory.organizationIdsOf.mockResolvedValue([org(1)]);
    orgAccess.hasPermission.mockResolvedValue(true);
    links.findInOrganization.mockResolvedValue(linkOf(org(1)));
    await expect(
      listLinks().execute(actor, HUB, {
        cursor: encodeCursor(org(1)),
        limit: 5,
      }),
    ).resolves.toEqual({ items: [], nextCursor: null });
  });

  it('sees the hub but administers no linked org: 403; does not see it: 404; a bad cursor: 422', async () => {
    directory.organizationIdsOf.mockResolvedValue([org(1)]);
    orgAccess.hasPermission.mockResolvedValue(true);
    links.findInOrganization.mockResolvedValue(null);
    access.find.mockResolvedValue({ role: 'hub_user' });
    await expect(
      listLinks().execute(actor, HUB, { limit: 5 }),
    ).rejects.toMatchObject({
      code: 'permission-denied',
    });
    access.find.mockResolvedValue(null);
    await expect(
      listLinks().execute(actor, HUB, { limit: 5 }),
    ).rejects.toMatchObject({
      code: 'hub-not-found',
    });
    await expect(
      listLinks().execute(actor, HUB, { cursor: 'nope', limit: 5 }),
    ).rejects.toMatchObject({ code: 'invalid-cursor' });
  });
});

describe('ListHubSpacesUseCase (cursor pagination)', () => {
  const ref = (n: number, orgId: string): HubSpaceRef => ({
    hubId: HUB,
    spaceId: space(n),
    organizationId: orgId,
    addedByUserId: USER,
  });

  it('owner: limit + 1 after the cursor from the repository', async () => {
    access.requireAccess.mockResolvedValue({ role: 'hub_owner' });
    hubSpaces.list.mockResolvedValue([ref(1, org(1)), ref(2, org(1))]);
    const page = await listSpaces().execute(actor, HUB, { limit: 1 });
    expect(hubSpaces.list).toHaveBeenCalledWith(HUB, {
      after: undefined,
      limit: 2,
    });
    expect(page).toEqual({
      items: [ref(1, org(1))],
      nextCursor: encodeCursor(space(1)),
    });
  });

  it('linked member: merges the per-org slices in space id order and pages through them', async () => {
    access.requireAccess.mockResolvedValue({ role: 'hub_user' });
    directory.organizationIdsOf.mockResolvedValue([org(1), org(2)]);
    const all = [
      ref(1, org(2)),
      ref(2, org(1)),
      ref(3, org(2)),
      ref(4, org(1)),
    ];
    hubSpaces.listInOrganization.mockImplementation(
      async (
        _h: string,
        orgId: string,
        slice: { after?: string; limit: number },
      ) =>
        all
          .filter(
            (r) =>
              r.organizationId === orgId &&
              (!slice.after || r.spaceId > slice.after),
          )
          .slice(0, slice.limit),
    );
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await listSpaces().execute(actor, HUB, { cursor, limit: 3 });
      seen.push(...page.items.map((r) => r.spaceId));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual([space(1), space(2), space(3), space(4)]);
  });
});
