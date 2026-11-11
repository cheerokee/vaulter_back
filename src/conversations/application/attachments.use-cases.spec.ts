import type { AttachmentUploader } from '../domain/conversation-attachment.js';
import { QueryFailedError } from 'typeorm';
import type { HubAuthContext } from '../../shared/application/hub-auth-context.js';
import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
} from '../../shared/domain/errors.js';
import { newId } from '../../shared/domain/id.js';
import type { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { SpaceStorage } from '../../spaces/application/space-storage.js';
import { SpaceStorageUsage } from '../../spaces/application/space-storage-usage.js';
import type { ObjectStore } from '../../storage/application/ports/object-store.js';
import type { ConversationScope } from '../domain/conversation-actor.js';
import { ConversationAttachment } from '../domain/conversation-attachment.js';
import type { ConversationAttachmentRepository } from '../domain/conversation-attachment.repository.js';
import { Conversation } from '../domain/conversation.js';
import { MAX_ATTACHMENT_BYTES } from '../domain/conversation-limits.js';
import { ConversationAttachmentHealer } from './attachment-healer.js';
import { ConfirmAttachmentUseCase } from './confirm-attachment.use-case.js';
import type { ConversationAccess } from './conversation-access.js';
import { GetAttachmentDownloadUrlUseCase } from './get-attachment-download-url.use-case.js';
import { RequestAttachmentUploadUseCase } from './request-attachment-upload.use-case.js';

const as = <T>(x: unknown) => x as T;
const ORG = newId();
const SPACE = newId();
const HUB = newId();
const ANA = newId();
const BIA = newId();
const CONV = newId();
const DB_NOW = new Date('2026-11-10T12:00:00.123Z');
const MARK = new Date('2026-11-10T12:00:00.050Z');
const GiB = 1024 ** 3;
const SHA = 'a'.repeat(64);

const conversation = (over: { keyRotationRequired?: boolean } = {}) =>
  Conversation.restore(
    {
      organizationId: ORG,
      spaceId: SPACE,
      createdByUserId: ANA,
      ownerUserId: ANA,
      executorHubId: HUB,
      state: 'na_fila',
      lastMessageAt: null,
      currentKeyVersion: 2,
      keyRotationRequired: over.keyRotationRequired ?? false,
      encryptedHeader: Buffer.alloc(60, 1).toString('base64url'),
      headerKeyVersion: 1,
      movedFromConversationId: null,
      cloudReserve: false,
      cloudReserveDeclined: false,
      participantUserIds: [ANA, BIA].sort(),
      createdAt: new Date(),
      deletedAt: null,
    },
    CONV,
  );

const userScope: ConversationScope = {
  organizationId: ORG,
  actor: { kind: 'user', userId: ANA },
};
const hubScope: ConversationScope = {
  organizationId: ORG,
  actor: { kind: 'hub', hubId: HUB },
};
const hub: HubAuthContext = { hubId: HUB };
const ana = { userId: ANA, sessionId: newId() };

const attachment = (
  over: {
    id?: string;
    uploader?: AttachmentUploader;
    sizeBytes?: number;
    expiresAt?: Date;
    committed?: string;
    conversationId?: string;
  } = {},
) => {
  const a = ConversationAttachment.create({
    id: over.id ?? newId(),
    organizationId: ORG,
    spaceId: SPACE,
    conversationId: over.conversationId ?? CONV,
    uploader: over.uploader ?? { kind: 'user', userId: ANA },
    messageId: null,
    keyVersion: 2,
    sizeBytes: over.sizeBytes ?? 1000,
    sha256: SHA,
    uploadExpiresAt: over.expiresAt ?? new Date(DB_NOW.getTime() + 3600_000),
  });
  if (over.committed) a.commit(over.committed);
  return a;
};

const finalKey = (id: string) =>
  `orgs/${ORG}/spaces/${SPACE}/conversations/${CONV}/${id}`;
const uploadKey = (id: string) =>
  `orgs/${ORG}/spaces/${SPACE}/conversations/${CONV}/uploads/${id}`;

describe('attachment use cases', () => {
  const trace: string[] = [];
  let current: Conversation;
  let quotaBytes: number | null;
  let otherUsage: number;
  const rows = new Map<string, ConversationAttachment>();
  const marks = new Map<string, Date>();
  let inUow = 0;

  const access = {
    userScope: vi.fn(async () => {
      trace.push('userScope');
      return userScope;
    }),
    findForUser: vi.fn(async () => {
      trace.push('findConversation');
      return { scope: userScope, conversation: current };
    }),
    findForHub: vi.fn(async () => {
      trace.push('findForHub');
      return { scope: hubScope, conversation: current };
    }),
    lock: vi.fn(
      async (
        _s: ConversationScope,
        _id: string,
        _space: string,
        mode = 'update',
      ) => {
        trace.push(`lockConversation:${mode}`);
        return current;
      },
    ),
  };
  const spaceStorage = {
    lockQuota: vi.fn(async () => {
      trace.push('lockSpace');
      return quotaBytes;
    }),
  };
  const repo = {
    databaseNow: vi.fn(async () => DB_NOW),
    findById: vi.fn(async (_s: ConversationScope, id: string) => {
      trace.push('findAttachment');
      return rows.get(id) ?? null;
    }),
    lockById: vi.fn(async (_s: ConversationScope, id: string) => {
      trace.push('lockAttachment');
      return rows.get(id) ?? null;
    }),
    insertIfAbsent: vi.fn(
      async (_s: ConversationScope, a: ConversationAttachment) => {
        trace.push('insert');
        if (rows.has(a.id)) return false;
        rows.set(a.id, a);
        return true;
      },
    ),
    save: vi.fn(async () => {
      trace.push('saveAttachment');
    }),
    markWrite: vi.fn(async (_s: ConversationScope, id: string) => {
      trace.push(`mark:${inUow}`);
      const a = rows.get(id);
      if (!a || a.status !== 'pending') return null;
      marks.set(id, MARK);
      return MARK;
    }),
    writeMark: vi.fn(async (_s: ConversationScope, id: string) => {
      trace.push('readMark');
      return marks.get(id) ?? null;
    }),
    lockMarked: vi.fn(async (_org: string, id: string) => {
      trace.push('lockMarked');
      return rows.get(id) ?? null;
    }),
    clearWriteMark: vi.fn(async () => undefined),
    staleWriteMarks: vi.fn(async () => []),
  };
  const store = {
    presignPut: vi.fn(async (key: string) => ({
      url: `https://s3/${key}`,
      headers: { 'x-amz-checksum-sha256': 'x' },
    })),
    presignGet: vi.fn(
      async (key: string, v: string) => `https://s3/${key}?v=${v}`,
    ),
    head: vi.fn(
      async (): Promise<{
        sizeBytes: number;
        sha256Hex: string | null;
        versionId: string | null;
      } | null> => ({ sizeBytes: 1000, sha256Hex: SHA, versionId: 'u1' }),
    ),
    copy: vi.fn(async (from: string, to: string) => {
      trace.push(`copy:${from}->${to}`);
      return { versionId: 's3v1' };
    }),
    listVersions: vi.fn(
      async (): Promise<{ versionId: string; isDeleteMarker: boolean }[]> => [],
    ),
    deleteVersion: vi.fn(async (_k: string, v: string) => {
      trace.push(`deleteVersion:${v}`);
    }),
  };
  const usage = new SpaceStorageUsage();
  usage.register('test', {
    usedBytes: async () => {
      trace.push('usedBytes');
      return (
        otherUsage + [...rows.values()].reduce((sum, a) => sum + a.sizeBytes, 0)
      );
    },
  });
  const uow = {
    run: vi.fn(async (work: () => Promise<unknown>) => {
      inUow++;
      trace.push(`run:${inUow}`);
      return work();
    }),
    setContext: vi.fn(async () => undefined),
    setLockTimeout: vi.fn(async () => {
      trace.push('lockTimeout');
    }),
    limitRemainingTime: vi.fn(async () => {
      trace.push('limitRemainingTime');
    }),
  };

  const healer = new ConversationAttachmentHealer(
    as<ConversationAttachmentRepository>(repo),
    as<ObjectStore>(store),
    as<UnitOfWork>(uow),
  );
  const request = new RequestAttachmentUploadUseCase(
    as<ConversationAccess>(access),
    as<SpaceStorage>(spaceStorage),
    usage,
    as<ConversationAttachmentRepository>(repo),
    as<ObjectStore>(store),
    as<UnitOfWork>(uow),
  );
  const confirm = new ConfirmAttachmentUseCase(
    as<ConversationAccess>(access),
    as<ConversationAttachmentRepository>(repo),
    as<ObjectStore>(store),
    healer,
    as<UnitOfWork>(uow),
  );
  const download = new GetAttachmentDownloadUrlUseCase(
    as<ConversationAccess>(access),
    as<ConversationAttachmentRepository>(repo),
    as<ObjectStore>(store),
  );

  const input = (over: Record<string, unknown> = {}) => ({
    id: newId(),
    keyVersion: 2,
    sizeBytes: 1000,
    sha256: SHA,
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    trace.length = 0;
    rows.clear();
    marks.clear();
    inUow = 0;
    current = conversation();
    quotaBytes = 10 * GiB;
    otherUsage = 0;
    store.head.mockImplementation(async () => ({
      sizeBytes: 1000,
      sha256Hex: SHA,
      versionId: 'u1',
    }));
    store.listVersions.mockImplementation(async () => []);
  });

  describe('request (intent)', () => {
    it('locks the space (FOR SHARE) before the conversation, reserves, reads the usage after the insert, signs the PUT after the commit', async () => {
      const i = input();
      const out = await request.byUser(ana, SPACE, CONV, i);
      expect(out.created).toBe(true);
      expect(trace).toEqual([
        'run:1',
        'lockTimeout',
        'userScope',
        'lockSpace',
        'lockConversation:update',
        'findAttachment',
        'insert',
        'usedBytes',
      ]);
      const saved = rows.get(i.id)!;
      expect(saved.status).toBe('pending');
      expect(saved.uploader).toEqual({ kind: 'user', userId: ANA });
      expect(saved.uploadExpiresAt).toEqual(
        new Date(DB_NOW.getTime() + 24 * 3600_000),
      );
      expect(store.presignPut).toHaveBeenCalledWith(uploadKey(i.id), {
        sizeBytes: 1000,
        sha256Hex: SHA,
        expiresInSeconds: 900,
      });
      expect(out.upload).toEqual({
        url: `https://s3/${uploadKey(i.id)}`,
        headers: { 'x-amz-checksum-sha256': 'x' },
        expiresAt: expect.any(Date),
      });
      expect(out.view).toMatchObject({
        id: i.id,
        conversationId: CONV,
        status: 'pending',
        sizeBytes: 1000,
        uploadedByUserId: ANA,
        uploadedByHubId: null,
      });
    });

    it('format first (422, nothing locked): over 100 MiB is attachment-too-large; bad sha256 / id', async () => {
      for (const bad of [
        input({ sizeBytes: MAX_ATTACHMENT_BYTES + 1 }),
        input({ sha256: 'A'.repeat(64) }),
        input({ id: 'nope' }),
      ]) {
        await expect(request.byUser(ana, SPACE, CONV, bad)).rejects.toThrow(
          DomainValidationError,
        );
      }
      await expect(
        request.byUser(
          ana,
          SPACE,
          CONV,
          input({ sizeBytes: MAX_ATTACHMENT_BYTES + 1 }),
        ),
      ).rejects.toMatchObject({ code: 'attachment-too-large' });
      expect(uow.run).not.toHaveBeenCalled();
    });

    it('pending rotation or a stale key version: 409, nothing written', async () => {
      current = conversation({ keyRotationRequired: true });
      await expect(
        request.byUser(ana, SPACE, CONV, input()),
      ).rejects.toMatchObject({
        code: 'conversation-key-rotation-required',
      });
      current = conversation();
      await expect(
        request.byUser(ana, SPACE, CONV, input({ keyVersion: 1 })),
      ).rejects.toMatchObject({ code: 'conversation-key-version-stale' });
      expect(repo.insertIfAbsent).not.toHaveBeenCalled();
    });

    it('the space does not fit it (counted after the insert): 422 space-storage-full', async () => {
      quotaBytes = 1500;
      otherUsage = 1000;
      await expect(
        request.byUser(ana, SPACE, CONV, input()),
      ).rejects.toMatchObject({
        code: 'space-storage-full',
        details: { missingBytes: 500 },
      });
      expect(store.presignPut).not.toHaveBeenCalled();
    });

    it('the same request again renews the window (200, a new URL); another request with the id is 409; a committed one has no URL', async () => {
      const i = input();
      await request.byUser(ana, SPACE, CONV, i);
      const again = await request.byUser(ana, SPACE, CONV, i);
      expect(again.created).toBe(false);
      expect(again.upload).not.toBeNull();
      expect(repo.save).toHaveBeenCalledTimes(1);
      await expect(
        request.byUser(ana, SPACE, CONV, { ...i, sizeBytes: 999 }),
      ).rejects.toMatchObject({ code: 'attachment-id-conflict' });
      rows.get(i.id)!.commit('s3v1');
      const done = await request.byUser(ana, SPACE, CONV, i);
      expect(done).toMatchObject({ created: false, upload: null });
      expect(done.view.status).toBe('committed');
    });

    it('an id the scope cannot see (insert refused) is 409 attachment-id-conflict', async () => {
      repo.insertIfAbsent.mockResolvedValueOnce(false);
      await expect(
        request.byUser(ana, SPACE, CONV, input()),
      ).rejects.toMatchObject({
        code: 'attachment-id-conflict',
      });
    });

    it('the hub: finds the conversation first (no lock), then space and conversation', async () => {
      const i = input();
      const out = await request.byHub(hub, CONV, i);
      expect(out.view.uploadedByHubId).toBe(HUB);
      expect(trace.slice(0, 5)).toEqual([
        'run:1',
        'lockTimeout',
        'findForHub',
        'lockSpace',
        'lockConversation:update',
      ]);
    });

    it('a lock wait past the timeout (55P03) is 409 storage-busy', async () => {
      const err = new QueryFailedError('SELECT', [], new Error('lock'));
      (err as unknown as { driverError: { code: string } }).driverError = {
        code: '55P03',
      };
      spaceStorage.lockQuota.mockRejectedValueOnce(err);
      await expect(
        request.byUser(ana, SPACE, CONV, input()),
      ).rejects.toMatchObject({
        code: 'storage-busy',
      });
    });
  });

  describe('confirm', () => {
    const pending = async (over: Parameters<typeof attachment>[0] = {}) => {
      const a = attachment(over);
      rows.set(a.id, a);
      return a;
    };

    it('marks in its own transaction BEFORE the unit of work; conversation FOR KEY SHARE, row FOR UPDATE, HEAD, mark rechecked, heal, copy, then the index', async () => {
      const a = await pending();
      const view = await confirm.byUser(ana, SPACE, CONV, a.id);
      expect(view.status).toBe('committed');
      expect(a.s3VersionId).toBe('s3v1');
      expect(trace).toEqual([
        'run:1',
        'lockTimeout',
        'findConversation',
        'mark:1',
        'run:2',
        'lockTimeout',
        'userScope',
        'lockConversation:key-share',
        'lockAttachment',
        'readMark',
        `copy:${uploadKey(a.id)}->${finalKey(a.id)}`,
        'limitRemainingTime',
        'saveAttachment',
      ]);
      expect(store.head).toHaveBeenCalledWith(uploadKey(a.id));
      expect(store.listVersions).toHaveBeenCalledWith(finalKey(a.id));
    });

    it('stray versions at the final key (an earlier attempt) are removed before the copy', async () => {
      const a = await pending();
      store.listVersions.mockResolvedValueOnce([
        { versionId: 'stray', isDeleteMarker: false },
      ]);
      await confirm.byUser(ana, SPACE, CONV, a.id);
      expect(trace.indexOf('deleteVersion:stray')).toBeLessThan(
        trace.findIndex((t) => t.startsWith('copy:')),
      );
    });

    it('bytes other than declared (or no PUT): 422 upload-mismatch, nothing copied', async () => {
      const a = await pending();
      store.head.mockResolvedValueOnce({
        sizeBytes: 999,
        sha256Hex: SHA,
        versionId: 'u1',
      });
      await expect(
        confirm.byUser(ana, SPACE, CONV, a.id),
      ).rejects.toMatchObject({
        code: 'upload-mismatch',
        details: { attachmentId: a.id },
      });
      store.head.mockResolvedValueOnce(null);
      await expect(
        confirm.byUser(ana, SPACE, CONV, a.id),
      ).rejects.toMatchObject({
        code: 'upload-mismatch',
      });
      expect(store.copy).not.toHaveBeenCalled();
      expect(a.status).toBe('pending');
    });

    it('the mark disappeared before the S3 write (sweep): 409 storage-busy, nothing copied', async () => {
      const a = await pending();
      repo.writeMark.mockResolvedValueOnce(null);
      await expect(
        confirm.byUser(ana, SPACE, CONV, a.id),
      ).rejects.toMatchObject({
        code: 'storage-busy',
      });
      expect(store.copy).not.toHaveBeenCalled();
    });

    it('another uploader, another conversation, past the window or unknown: 404 attachment-not-found', async () => {
      const other = await pending({ uploader: { kind: 'user', userId: BIA } });
      const late = await pending({ expiresAt: new Date(DB_NOW.getTime() - 1) });
      const elsewhere = await pending({ conversationId: newId() });
      for (const id of [other.id, late.id, elsewhere.id, newId()]) {
        await expect(
          confirm.byUser(ana, SPACE, CONV, id),
        ).rejects.toBeInstanceOf(NotFoundError);
      }
      expect(store.copy).not.toHaveBeenCalled();
    });

    it('a rotation pending since the intent: 409 conversation-key-rotation-required', async () => {
      const a = await pending();
      current = conversation({ keyRotationRequired: true });
      await expect(
        confirm.byUser(ana, SPACE, CONV, a.id),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(store.copy).not.toHaveBeenCalled();
    });

    it('already committed: the same answer, nothing copied (a retry after a timeout)', async () => {
      const a = await pending({ committed: 's3v0' });
      const view = await confirm.byUser(ana, SPACE, CONV, a.id);
      expect(view.status).toBe('committed');
      expect(store.copy).not.toHaveBeenCalled();
    });

    it('the unit of work fails after the copy: the attachment is repaired in a new transaction (reconcile context) and the error goes up', async () => {
      const a = await pending();
      repo.save.mockRejectedValueOnce(new Error('commit lost'));
      store.listVersions
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ versionId: 's3v1', isDeleteMarker: false }]);
      // What the database holds after the rollback: still pending (the repair reads the row again under its lock).
      repo.lockMarked.mockResolvedValueOnce(attachment({ id: a.id }));
      await expect(confirm.byUser(ana, SPACE, CONV, a.id)).rejects.toThrow(
        'commit lost',
      );
      expect(repo.lockMarked).toHaveBeenCalledWith(ORG, a.id);
      expect(store.deleteVersion).toHaveBeenCalledWith(finalKey(a.id), 's3v1');
      expect(repo.clearWriteMark).not.toHaveBeenCalled();
    });

    it('the hub confirms its own upload', async () => {
      const a = await pending({ uploader: { kind: 'hub', hubId: HUB } });
      const view = await confirm.byHub(hub, CONV, a.id);
      expect(view).toMatchObject({ status: 'committed', uploadedByHubId: HUB });
    });
  });

  describe('download', () => {
    it('signs a GET of the version recorded in the index (never the current S3 one)', async () => {
      const a = attachment({ committed: 's3v7' });
      rows.set(a.id, a);
      const out = await download.byUser(ana, SPACE, CONV, a.id);
      expect(store.presignGet).toHaveBeenCalledWith(
        finalKey(a.id),
        's3v7',
        900,
      );
      expect(out.url).toBe(`https://s3/${finalKey(a.id)}?v=s3v7`);
      expect(out.expiresAt).toBeInstanceOf(Date);
      expect(uow.run).not.toHaveBeenCalled();
    });

    it('pending, deleted, of another conversation or unknown: 404 attachment-not-found', async () => {
      const p = attachment();
      const gone = attachment({ committed: 's3v1' });
      gone.tombstone(DB_NOW);
      const elsewhere = attachment({
        committed: 's3v1',
        conversationId: newId(),
      });
      for (const a of [p, gone, elsewhere]) rows.set(a.id, a);
      for (const id of [p.id, gone.id, elsewhere.id, newId()]) {
        await expect(
          download.byUser(ana, SPACE, CONV, id),
        ).rejects.toMatchObject({
          code: 'attachment-not-found',
        });
      }
      const ok = attachment({ committed: 's3v2' });
      rows.set(ok.id, ok);
      await expect(download.byHub(hub, CONV, ok.id)).resolves.toMatchObject({
        url: expect.any(String),
      });
    });
  });

  describe('healer', () => {
    it('keeps only the committed version; a pending or purged attachment keeps nothing; the sweep clears old marks', async () => {
      const a = attachment({ committed: 'keep' });
      rows.set(a.id, a);
      store.listVersions.mockResolvedValue([
        { versionId: 'keep', isDeleteMarker: false },
        { versionId: 'stray', isDeleteMarker: false },
        { versionId: 'marker', isDeleteMarker: true },
      ]);
      expect(
        await healer.repair([{ organizationId: ORG, attachmentId: a.id }], 60),
      ).toBe(2);
      expect(store.deleteVersion.mock.calls.map((c) => c[1])).toEqual([
        'stray',
        'marker',
      ]);
      expect(repo.clearWriteMark).toHaveBeenCalledWith(ORG, a.id, 60);

      store.deleteVersion.mockClear();
      a.purge();
      expect(await healer.heal(a)).toBe(3);
    });

    it('never throws: a failed repair is logged and the mark stays', async () => {
      repo.lockMarked.mockRejectedValueOnce(new Error('db down'));
      await expect(
        healer.repair([{ organizationId: ORG, attachmentId: newId() }], 60),
      ).resolves.toBe(0);
      expect(repo.clearWriteMark).not.toHaveBeenCalled();
    });
  });
});
