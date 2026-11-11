import {
  ConflictError,
  DomainValidationError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';
import { newId } from '../../shared/domain/id.js';
import { Conversation } from './conversation.js';
import { MAX_HEADER_BYTES } from './conversation-limits.js';
import { CONVERSATION_STATES } from './conversation-state.js';

const now = new Date('2026-11-09T12:00:00.000Z');
// `0x01 ‖ bytes`, base64url: the shape of every encrypted blob (41 bytes is the smallest: empty plaintext).
const blob = (bytes: number) => {
  const b = Buffer.alloc(bytes, 0xab);
  b[0] = 0x01;
  return b.toString('base64url');
};

const OWNER = newId();
const OTHER = newId();
const HUB = newId();

const make = (over: Partial<Parameters<typeof Conversation.create>[0]> = {}) =>
  Conversation.create({
    id: newId(),
    organizationId: 'org',
    spaceId: 'space',
    createdByUserId: OWNER,
    ownerUserId: OWNER,
    executorHubId: HUB,
    state: 'na_fila',
    encryptedHeader: blob(100),
    now,
    ...over,
  });

const user = (userId: string) => ({ kind: 'user', userId }) as const;
const hub = (hubId: string) => ({ kind: 'hub', hubId }) as const;

describe('Conversation', () => {
  it('is born at key version 1, with the owner as the only participant and the header at version 1', () => {
    const c = make();
    expect(c.currentKeyVersion).toBe(1);
    expect(c.keyRotationRequired).toBe(false);
    expect(c.headerKeyVersion).toBe(1);
    expect(c.participantUserIds).toEqual([OWNER]);
    expect(c.ownerUserId).toBe(OWNER);
    expect(c.executorHubId).toBe(HUB);
    expect(c.lastMessageAt).toBeNull();
    expect(c.deletedAt).toBeNull();
    expect(c.createdAt).toBe(now);
  });

  it('accepts no executor (only on the app, waiting for one)', () => {
    expect(make({ executorHubId: null }).executorHubId).toBeNull();
  });

  it.each(['not-a-uuid', '0190a0c8-1f2e-4b3c-8d4e-5f6a7b8c9d0e'])(
    'rejects id %s (device ids are uuid v7)',
    (id) => {
      expect(() => make({ id })).toThrow(DomainValidationError);
    },
  );

  it('rejects being moved from itself', () => {
    const id = newId();
    expect(() => make({ id, movedFromConversationId: id })).toThrow(
      DomainValidationError,
    );
    expect(
      make({ movedFromConversationId: OTHER }).movedFromConversationId,
    ).toBe(OTHER);
  });

  it('accepts a 16 KiB header and refuses one byte more (422 header-too-large)', () => {
    expect(() =>
      make({ encryptedHeader: blob(MAX_HEADER_BYTES) }),
    ).not.toThrow();
    try {
      make({ encryptedHeader: blob(MAX_HEADER_BYTES + 1) });
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(DomainValidationError);
      expect((e as DomainValidationError).code).toBe('header-too-large');
    }
  });

  it.each([
    ['not base64url', '***'],
    ['wrong version byte', Buffer.alloc(60, 0x02).toString('base64url')],
    ['shorter than the 41-byte overhead', blob(40)],
    ['padding', `${blob(60)}=`],
  ])('rejects a header with %s', (_, header) => {
    expect(() => make({ encryptedHeader: header })).toThrow(
      DomainValidationError,
    );
  });

  it('rejects an unknown state', () => {
    expect(() => make({ state: 'feito' as never })).toThrow(
      DomainValidationError,
    );
    expect(CONVERSATION_STATES).toEqual([
      'aviso',
      'trabalhando',
      'na_fila',
      'pede_sim',
      'esperando_pc',
      'concluido',
      'arquivado',
    ]);
  });

  describe('who may change the state', () => {
    it('the executor moves the work states', () => {
      const c = make();
      c.changeState(hub(HUB), 'trabalhando');
      expect(c.state).toBe('trabalhando');
      c.changeState(hub(HUB), 'concluido');
      expect(c.state).toBe('concluido');
    });

    it('a participant, even the owner, does not move the work states (403)', () => {
      const c = make();
      expect(() => c.changeState(user(OWNER), 'trabalhando')).toThrow(
        PermissionDeniedError,
      );
      expect(() => c.changeState(hub(newId()), 'trabalhando')).toThrow(
        PermissionDeniedError,
      );
    });

    it('only the owner archives and reopens (403 not-conversation-owner)', () => {
      const c = make();
      try {
        c.changeState(hub(HUB), 'arquivado');
        expect.fail('should throw');
      } catch (e) {
        expect((e as PermissionDeniedError).code).toBe(
          'not-conversation-owner',
        );
      }
      expect(() => c.changeState(user(OTHER), 'arquivado')).toThrow(
        PermissionDeniedError,
      );
      c.changeState(user(OWNER), 'arquivado');
      expect(c.state).toBe('arquivado');
      expect(() => c.changeState(hub(HUB), 'na_fila')).toThrow(
        PermissionDeniedError,
      );
      c.changeState(user(OWNER), 'na_fila');
      expect(c.state).toBe('na_fila');
    });

    it('setting the current state again is a no-op for anyone', () => {
      const c = make();
      expect(() => c.changeState(user(OTHER), 'na_fila')).not.toThrow();
    });
  });

  it('assertOwner: 403 not-conversation-owner for anyone else', () => {
    const c = make();
    expect(() => c.assertOwner(OWNER)).not.toThrow();
    expect(() => c.assertOwner(OTHER)).toThrow(PermissionDeniedError);
  });

  describe('executor', () => {
    it('replacing an executor requires a key rotation (the old one knew the key)', () => {
      const c = make();
      const next = newId();
      c.changeExecutor(next);
      expect(c.executorHubId).toBe(next);
      expect(c.keyRotationRequired).toBe(true);
    });

    it('choosing the first executor does not', () => {
      const c = make({ executorHubId: null });
      c.changeExecutor(HUB);
      expect(c.keyRotationRequired).toBe(false);
      c.changeExecutor(HUB);
      expect(c.keyRotationRequired).toBe(false);
    });

    it('losing the executor clears it and requires a rotation; without one, nothing changes', () => {
      const c = make();
      expect(c.loseExecutor()).toBe(true);
      expect(c.executorHubId).toBeNull();
      expect(c.keyRotationRequired).toBe(true);
      const d = make({ executorHubId: null });
      expect(d.loseExecutor()).toBe(false);
      expect(d.keyRotationRequired).toBe(false);
    });
  });

  describe('key versions', () => {
    it('writes need the current version and no pending rotation', () => {
      const c = make();
      expect(() => c.assertCanWrite(1)).not.toThrow();
      try {
        c.assertCanWrite(2);
        expect.fail('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ConflictError);
        expect((e as ConflictError).code).toBe(
          'conversation-key-version-stale',
        );
        expect((e as ConflictError).details).toEqual({ expectedVersion: 1 });
      }
      c.markRotationRequired();
      try {
        c.assertCanWrite(1);
        expect.fail('should throw');
      } catch (e) {
        expect((e as ConflictError).code).toBe(
          'conversation-key-rotation-required',
        );
      }
    });

    it('a rotation goes to exactly current + 1 and clears the flag', () => {
      const c = make();
      c.markRotationRequired();
      expect(() => c.completeRotation(3)).toThrow(ConflictError);
      c.completeRotation(2);
      expect(c.currentKeyVersion).toBe(2);
      expect(c.keyRotationRequired).toBe(false);
      expect(() => c.assertCanWrite(1)).toThrow(ConflictError);
    });

    it('the header is replaced only with the current version', () => {
      const c = make();
      c.markRotationRequired();
      c.completeRotation(2);
      expect(() => c.replaceHeader(blob(80), 1)).toThrow(ConflictError);
      c.replaceHeader(blob(80), 2);
      expect(c.headerKeyVersion).toBe(2);
      expect(c.encryptedHeader).toBe(blob(80));
    });
  });

  it('lastMessageAt only moves forward', () => {
    const c = make();
    const later = new Date(now.getTime() + 1000);
    c.recordMessage(later);
    c.recordMessage(now);
    expect(c.lastMessageAt).toEqual(later);
  });

  it('transfers ownership only to a participant', () => {
    const c = Conversation.restore(
      { ...make().snapshot(), participantUserIds: [OWNER, OTHER] },
      newId(),
    );
    c.transferOwnership(OTHER);
    expect(c.ownerUserId).toBe(OTHER);
    expect(() => c.transferOwnership(newId())).toThrow(DomainValidationError);
  });

  it('a tombstone keeps the header for the retention window; purging needs the tombstone', () => {
    const c = make();
    expect(() => c.purgeHeader()).toThrow();
    c.tombstone(now);
    expect(c.deletedAt).toBe(now);
    expect(c.encryptedHeader).not.toBeNull();
    c.purgeHeader();
    expect(c.encryptedHeader).toBeNull();
    expect(c.headerKeyVersion).toBeNull();
  });
});

describe('Conversation: the cloud as reserve executor', () => {
  const shared = (over: { cloudReserve?: boolean } = {}) => {
    const c = make({ cloudReserve: over.cloudReserve ?? false });
    return Conversation.restore(
      { ...c.snapshot(), participantUserIds: [OWNER, OTHER] },
      c.id,
    );
  };
  const cloud = { kind: 'cloud', spaceId: 'space' } as const;

  it('is born with or without the reserve; only a live conversation with it lets the cloud act', () => {
    expect(make().cloudReserve).toBe(false);
    const c = make({ cloudReserve: true });
    expect(c.isCloudExecutor()).toBe(true);
    c.changeState(cloud, 'trabalhando');
    expect(c.state).toBe('trabalhando');
    expect(() => c.changeState(cloud, 'arquivado')).toThrow(
      PermissionDeniedError,
    );
    c.tombstone(now);
    expect(c.cloudReserve).toBe(false);
    expect(c.isCloudExecutor()).toBe(false);
  });

  it('the cloud never rotates the key (404) and cannot move work states without the reserve', () => {
    const c = make();
    c.markRotationRequired();
    expect(() => c.assertRotationAllowed(cloud)).toThrow();
    expect(() => c.changeState(cloud, 'trabalhando')).toThrow(
      PermissionDeniedError,
    );
  });

  it('any participant switches it on; after the owner declined, only the owner', () => {
    const c = shared();
    expect(c.enableCloudReserve(OTHER)).toBe(true);
    expect(c.enableCloudReserve(OTHER)).toBe(false); // already on
    expect(() => c.declineCloudReserve(OTHER)).toThrow(PermissionDeniedError);
    expect(c.declineCloudReserve(OWNER)).toBe(true);
    expect(c.cloudReserve).toBe(false);
    expect(c.cloudReserveDeclined).toBe(true);
    expect(c.keyRotationRequired).toBe(true);
    expect(() => c.enableCloudReserve(OTHER)).toThrow(PermissionDeniedError);
    expect(c.enableCloudReserve(OWNER)).toBe(true);
    expect(c.cloudReserveDeclined).toBe(false);
    expect(() => c.enableCloudReserve(newId())).toThrow();
  });

  it('losing it (space out of the active cloud) is not a decline, and asks for a rotation', () => {
    const c = shared({ cloudReserve: true });
    expect(c.loseCloudReserve()).toBe(true);
    expect(c.cloudReserve).toBe(false);
    expect(c.cloudReserveDeclined).toBe(false);
    expect(c.keyRotationRequired).toBe(true);
    expect(c.loseCloudReserve()).toBe(false);
  });
});
