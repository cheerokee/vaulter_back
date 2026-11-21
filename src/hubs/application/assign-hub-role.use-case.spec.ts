import type { AuditLog } from '../../organizations/application/audit-log.js';
import type { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import type { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { DomainValidationError } from '../../shared/domain/errors.js';
import type { HubOrganizationRepository } from '../domain/hub-organization.repository.js';
import type { HubRoleRepository } from '../domain/hub-role.repository.js';
import { Hub } from '../domain/hub.js';
import type { HubRepository } from '../domain/hub.repository.js';
import { AssignHubRoleUseCase } from './assign-hub-role.use-case.js';
import type { HubAccess } from './hub-access.js';

const HUB_ID = '019a0000-0000-7000-8000-0000000000aa';
const OWNER = '019a0000-0000-7000-8000-0000000000a1';
const MEMBER = '019a0000-0000-7000-8000-0000000000b1';
const as = <T>(x: unknown) => x as T;

const pcHub = () =>
  Hub.restore(
    {
      ownerUserId: OWNER,
      name: 'PC',
      signingPublicKey: 's',
      encryptionPublicKey: 'e',
      lastSeenAt: null,
      deletedAt: null,
      kind: 'pc',
    },
    HUB_ID,
  );

const access = { requireOwner: vi.fn() };
const directory = { lockActiveMember: vi.fn() };
const hubs = { lockForShare: vi.fn() };
const links = { listActiveOrgIds: vi.fn(), lockForShare: vi.fn() };
const hubRoles = { assign: vi.fn() };
const audit = { record: vi.fn() };
const uow = {
  run: vi.fn(async (work: () => Promise<unknown>) => work()),
  setContext: vi.fn(async () => undefined),
};

const useCase = () =>
  new AssignHubRoleUseCase(
    as<HubAccess>(access),
    as<OrganizationDirectory>(directory),
    as<HubRepository>(hubs),
    as<HubOrganizationRepository>(links),
    as<HubRoleRepository>(hubRoles),
    as<AuditLog>(audit),
    as<UnitOfWork>(uow),
  );

describe('AssignHubRoleUseCase on a pc hub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    access.requireOwner.mockResolvedValue(pcHub());
  });

  it.each(['hub_operator', 'hub_user'])(
    'refuses %s on a pc hub: 422 agent-not-shareable, before writing',
    async (roleKey) => {
      await expect(
        useCase().execute(
          { userId: OWNER, sessionId: 's1' },
          { hubId: HUB_ID, userId: MEMBER, roleKey },
        ),
      ).rejects.toMatchObject({
        constructor: DomainValidationError,
        code: 'agent-not-shareable',
      });
      expect(hubs.lockForShare).not.toHaveBeenCalled();
      expect(hubRoles.assign).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );
});
