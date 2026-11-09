import type { HubBoundSessions } from '../../identity/application/hub-bound-sessions.js';
import type { HubRepository } from '../domain/hub.repository.js';
import type { HubAccess } from './hub-access.js';
import { HubPersonSessions } from './hub-person-sessions.js';

const HUB_A = '019a0000-0000-7000-8000-0000000000aa';
const HUB_B = '019a0000-0000-7000-8000-0000000000bb';
const ANA = '019a0000-0000-7000-8000-000000000001';
const BIA = '019a0000-0000-7000-8000-000000000002';

const as = <T>(v: unknown) => v as T;

describe('HubPersonSessions', () => {
  const calls: string[] = [];
  const hubs = {
    lockForShare: vi.fn(async (id: string) => {
      calls.push(`lockHub:${id}`);
      return { id };
    }),
    lockPersonSessions: vi.fn(async (id: string, mode: string) => {
      calls.push(`advisory:${mode}:${id}`);
    }),
  };
  const access = {
    hasAccess: vi.fn(async (hubId: string, userId: string) => {
      calls.push(`hasAccess:${hubId}:${userId}`);
      return userId === ANA;
    }),
  };
  const sessions = {
    activeUserIdsOnHub: vi.fn(async (hubId: string) => {
      calls.push(`candidates:${hubId}`);
      return [ANA, BIA];
    }),
    revokeAllForUserOnHub: vi.fn(async (userId: string, hubId: string) => {
      calls.push(`revoke:${hubId}:${userId}`);
      return 1;
    }),
    revokeAllOnHub: vi.fn(async (hubId: string) => {
      calls.push(`revokeAll:${hubId}`);
      return 2;
    }),
  };
  const service = new HubPersonSessions(
    as<HubRepository>(hubs),
    as<HubAccess>(access),
    as<HubBoundSessions>(sessions),
  );

  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
  });

  it('login gate: hub FOR SHARE -> shared advisory -> role check', async () => {
    expect(await service.isAllowed(HUB_A, ANA)).toBe(true);
    expect(await service.isAllowed(HUB_A, BIA)).toBe(false);
    expect(calls.slice(0, 3)).toEqual([
      `lockHub:${HUB_A}`,
      `advisory:shared:${HUB_A}`,
      `hasAccess:${HUB_A}:${ANA}`,
    ]);
  });

  it('login gate: a missing or deregistered hub is false, without checking the role', async () => {
    hubs.lockForShare.mockResolvedValueOnce(null as never);
    expect(await service.isAllowed(HUB_A, ANA)).toBe(false);
    expect(access.hasAccess).not.toHaveBeenCalled();
    expect(hubs.lockPersonSessions).not.toHaveBeenCalled();
  });

  it('sweep: each hub once, in id order, exclusive advisory before reading; only who lost access is revoked', async () => {
    await service.revokeLostAccess([HUB_B, HUB_A, HUB_B]);
    expect(calls).toEqual([
      `advisory:exclusive:${HUB_A}`,
      `candidates:${HUB_A}`,
      `hasAccess:${HUB_A}:${ANA}`,
      `hasAccess:${HUB_A}:${BIA}`,
      `revoke:${HUB_A}:${BIA}`,
      `advisory:exclusive:${HUB_B}`,
      `candidates:${HUB_B}`,
      `hasAccess:${HUB_B}:${ANA}`,
      `hasAccess:${HUB_B}:${BIA}`,
      `revoke:${HUB_B}:${BIA}`,
    ]);
  });

  it('deregistration revokes every session of the hub', async () => {
    await service.revokeAll(HUB_A);
    expect(calls).toEqual([`revokeAll:${HUB_A}`]);
  });
});
