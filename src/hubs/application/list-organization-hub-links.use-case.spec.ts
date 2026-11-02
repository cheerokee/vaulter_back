import {
  NotFoundError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';
import { encodeCursor } from '../../shared/domain/pagination.js';
import type { OrganizationAccess } from '../../organizations/application/organization-access.js';
import type { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { HubOrganizationRepository } from '../domain/hub-organization.repository.js';
import type { HubRepository } from '../domain/hub.repository.js';
import { ListOrganizationHubLinksUseCase } from './list-organization-hub-links.use-case.js';

const ORG = '019a0000-0000-7000-8000-0000000000c1';
const USER = '019a0000-0000-7000-8000-0000000000b1';
const hub = (n: number) =>
  `019a0000-0000-7000-8000-00000000a${n.toString().padStart(3, '0')}`;
const actor = { userId: USER, sessionId: 's' };
const at = new Date('2026-11-01T12:00:00.000Z');

const calls: string[] = [];
const orgAccess = { requirePermission: vi.fn() };
const links = { listOfOrganization: vi.fn() };
const hubs = { namesOf: vi.fn() };
const uow = {
  withContext: vi.fn(async (ctx: unknown, work: () => Promise<unknown>) => {
    calls.push(`withContext:${JSON.stringify(ctx)}`);
    return work();
  }),
};
const linkOf = (hubId: string, status = 'pending') => ({
  hubId,
  organizationId: ORG,
  status,
  requestedByUserId: USER,
  ownerApprovedAt: status === 'approved' ? at : null,
  orgApprovedAt: null,
  createdAt: at,
});
const useCase = () =>
  new ListOrganizationHubLinksUseCase(
    orgAccess as unknown as OrganizationAccess,
    links as unknown as HubOrganizationRepository,
    hubs as unknown as HubRepository,
    uow as unknown as UnitOfWork,
  );

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  orgAccess.requirePermission.mockImplementation(async () => {
    calls.push('requirePermission');
  });
  links.listOfOrganization.mockImplementation(async () => {
    calls.push('list');
    return [hub(1), hub(2), hub(3)].map((h) => linkOf(h));
  });
  hubs.namesOf.mockImplementation(async (ids: string[]) => {
    calls.push('names');
    return new Map(ids.map((id) => [id, `name-${id.slice(-3)}`]));
  });
});

describe('ListOrganizationHubLinksUseCase', () => {
  it('requires org.hubs.approve on the org first, then pages by hub id with the status filter and the hub names', async () => {
    const page = await useCase().execute(actor, ORG, {
      cursor: encodeCursor(hub(0)),
      limit: 2,
      status: 'pending',
    });
    expect(orgAccess.requirePermission).toHaveBeenCalledWith(
      ORG,
      USER,
      'org.hubs.approve',
    );
    expect(calls).toEqual([
      `withContext:${JSON.stringify({ userId: USER })}`,
      'requirePermission',
      'list',
      'names',
    ]);
    expect(links.listOfOrganization).toHaveBeenCalledWith(ORG, {
      status: 'pending',
      after: hub(0),
      limit: 3,
    });
    // names only for the items shown
    expect(hubs.namesOf).toHaveBeenCalledWith([hub(1), hub(2)]);
    expect(page).toEqual({
      items: [
        { ...linkOf(hub(1)), hubName: 'name-001' },
        { ...linkOf(hub(2)), hubName: 'name-002' },
      ],
      nextCursor: encodeCursor(hub(2)),
    });
  });

  it('a hub without a readable name gives hubName null; the last page has no cursor', async () => {
    links.listOfOrganization.mockResolvedValueOnce([linkOf(hub(7))]);
    hubs.namesOf.mockResolvedValueOnce(new Map());
    await expect(useCase().execute(actor, ORG, { limit: 20 })).resolves.toEqual(
      {
        items: [{ ...linkOf(hub(7)), hubName: null }],
        nextCursor: null,
      },
    );
    expect(links.listOfOrganization).toHaveBeenCalledWith(ORG, {
      status: undefined,
      after: undefined,
      limit: 21,
    });
  });

  it('404 for a non-member and 403 without the permission, before reading any link', async () => {
    for (const error of [
      new NotFoundError('organization-not-found', 'x'),
      new PermissionDeniedError('permission-denied', 'x'),
    ]) {
      orgAccess.requirePermission.mockRejectedValueOnce(error);
      await expect(useCase().execute(actor, ORG, { limit: 20 })).rejects.toBe(
        error,
      );
    }
    expect(links.listOfOrganization).not.toHaveBeenCalled();
    expect(hubs.namesOf).not.toHaveBeenCalled();
  });

  it('a bad cursor is 422 invalid-cursor', async () => {
    await expect(
      useCase().execute(actor, ORG, { cursor: 'bad!', limit: 20 }),
    ).rejects.toMatchObject({ code: 'invalid-cursor' });
  });
});
