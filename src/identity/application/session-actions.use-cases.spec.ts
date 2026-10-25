import { NotFoundError } from '../../shared/domain/errors.js';
import type { SessionRepository } from '../domain/session.repository.js';
import { ListSessionsUseCase } from './list-sessions.use-case.js';
import { LogoutUseCase } from './logout.use-case.js';
import { RevokeSessionUseCase } from './revoke-session.use-case.js';
import { NOW, makeSession } from '../../../test/support/test-sessions.js';

const sessions = {
  findById: vi.fn(),
  revoke: vi.fn(),
  listActiveByUser: vi.fn(),
};
const repo = sessions as unknown as SessionRepository;
const auth = { userId: 'u1', sessionId: 's1' };

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  sessions.revoke.mockResolvedValue(true);
});
afterEach(() => vi.useRealTimers());

describe('LogoutUseCase', () => {
  it('revokes the current session with logout', async () => {
    await new LogoutUseCase(repo).execute(auth);
    expect(sessions.revoke).toHaveBeenCalledWith('s1', 'logout', NOW);
  });

  it('resolves when the session was already revoked (first reason wins)', async () => {
    sessions.revoke.mockResolvedValue(false);
    await expect(
      new LogoutUseCase(repo).execute(auth),
    ).resolves.toBeUndefined();
  });
});

describe('ListSessionsUseCase', () => {
  it('marks the current session', async () => {
    sessions.listActiveByUser.mockResolvedValue({
      items: [makeSession({ id: 's2' }), makeSession({ id: 's1' })],
      nextCursor: 'c',
    });
    const page = { limit: 10 };
    const result = await new ListSessionsUseCase(repo).execute(auth, page);
    expect(sessions.listActiveByUser).toHaveBeenCalledWith('u1', NOW, page);
    expect(result.nextCursor).toBe('c');
    expect(result.items.map((i) => [i.id, i.current])).toEqual([
      ['s2', false],
      ['s1', true],
    ]);
    expect(result.items[0]).toEqual({
      id: 's2',
      deviceName: 'Pixel',
      devicePlatform: 'android',
      createdAt: new Date('2026-10-24T10:00:00Z'),
      lastUsedAt: new Date('2026-10-24T11:00:00Z'),
      lastIp: '1.2.3.4',
      current: false,
    });
  });
});

describe('RevokeSessionUseCase', () => {
  const useCase = () => new RevokeSessionUseCase(repo);

  it('revokes one of the own sessions', async () => {
    sessions.findById.mockResolvedValue(makeSession({ id: 's2' }));
    await useCase().execute(auth, 's2');
    expect(sessions.revoke).toHaveBeenCalledWith('s2', 'revoked', NOW);
  });

  it('hides sessions of other users as not found', async () => {
    sessions.findById.mockResolvedValue(makeSession({ userId: 'other' }));
    await expect(useCase().execute(auth, 's1')).rejects.toMatchObject({
      constructor: NotFoundError,
      code: 'session-not-found',
    });
    expect(sessions.revoke).not.toHaveBeenCalled();
  });

  it('reports a missing session as not found', async () => {
    sessions.findById.mockResolvedValue(null);
    await expect(useCase().execute(auth, 'x')).rejects.toMatchObject({
      code: 'session-not-found',
    });
  });

  it('resolves when the session was already revoked (first reason wins)', async () => {
    sessions.findById.mockResolvedValue(makeSession({ revoked: true }));
    sessions.revoke.mockResolvedValue(false);
    await expect(useCase().execute(auth, 's1')).resolves.toBeUndefined();
  });
});
