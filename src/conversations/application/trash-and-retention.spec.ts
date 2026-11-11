import type { CurrentAuthProofVerifier } from '../../identity/application/current-auth-proof-verifier.js';
import type { AuditLog } from '../../organizations/application/audit-log.js';
import {
  DomainValidationError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';
import { newId } from '../../shared/domain/id.js';
import type { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { ObjectStore } from '../../storage/application/ports/object-store.js';
import type { ConversationScope } from '../domain/conversation-actor.js';
import type {
  ConversationAttachmentRepository,
  PurgedAttachment,
} from '../domain/conversation-attachment.repository.js';
import type { ConversationMessageRepository } from '../domain/conversation-message.repository.js';
import { Conversation } from '../domain/conversation.js';
import { MAX_CONVERSATION_PURGE_ATTACHMENTS } from '../domain/conversation-limits.js';
import type { ConversationAccess } from './conversation-access.js';
import {
  ConversationRetention,
  RetentionLoginError,
} from './conversation-retention.js';
import { EmptyConversationTrashUseCase } from './empty-conversation-trash.use-case.js';
import type { ConversationRetentionStore } from './ports/conversation-retention-store.js';

const as = <T>(x: unknown) => x as T;
const ORG = newId();
const SPACE = newId();
const ANA = newId();
const BIA = newId();
const CONV = newId();
const ana = { userId: ANA, sessionId: newId() };

const conversation = (owner = ANA) =>
  Conversation.restore(
    {
      organizationId: ORG,
      spaceId: SPACE,
      createdByUserId: owner,
      ownerUserId: owner,
      executorHubId: null,
      state: 'na_fila',
      lastMessageAt: null,
      currentKeyVersion: 1,
      keyRotationRequired: false,
      encryptedHeader: Buffer.alloc(60, 1).toString('base64url'),
      headerKeyVersion: 1,
      movedFromConversationId: null,
      cloudReserve: false,
      cloudReserveDeclined: false,
      cloudAnswer: false,
      participantUserIds: [ANA, BIA].sort(),
      createdAt: new Date(),
      deletedAt: null,
    },
    CONV,
  );

const purged = (sizeBytes: number): PurgedAttachment => ({
  organizationId: ORG,
  spaceId: SPACE,
  conversationId: CONV,
  id: newId(),
  s3VersionId: `v-${newId()}`,
  sizeBytes,
});

describe('EmptyConversationTrashUseCase', () => {
  const trace: string[] = [];
  const scope: ConversationScope = {
    organizationId: ORG,
    actor: { kind: 'user', userId: ANA },
  };
  let current: Conversation;
  let batch: PurgedAttachment[];
  let committed: boolean;

  const access = {
    findForUser: vi.fn(async () => {
      trace.push('find');
      return { scope, conversation: current };
    }),
    lockForUser: vi.fn(async () => {
      trace.push('lock');
      return { scope, conversation: current };
    }),
  };
  const verifier = {
    verify: vi.fn(async (_u: string, proof: string) => {
      trace.push('verify');
      if (proof !== 'ok') {
        throw new DomainValidationError('current-auth-proof-invalid', 'x');
      }
    }),
  };
  const messages = {
    purgeTrash: vi.fn(async () => {
      trace.push('purgeMessages');
      return { messages: 2, bytes: 300 };
    }),
  };
  const attachments = {
    purgeTrash: vi.fn(async () => {
      trace.push('purgeAttachments');
      return batch;
    }),
    trashCount: vi.fn(async () => 5),
  };
  const store = {
    deleteVersions: vi.fn(async () => {
      trace.push(committed ? 'deleteVersions:after-commit' : 'deleteVersions');
      return { failed: [] };
    }),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const uow = {
    run: vi.fn(async (work: () => Promise<unknown>) => {
      committed = false;
      const r = await work();
      committed = true;
      return r;
    }),
    setContext: vi.fn(async () => undefined),
    setLockTimeout: vi.fn(async () => undefined),
  };
  const useCase = () =>
    new EmptyConversationTrashUseCase(
      as<ConversationAccess>(access),
      as<CurrentAuthProofVerifier>(verifier),
      as<ConversationMessageRepository>(messages),
      as<ConversationAttachmentRepository>(attachments),
      as<ObjectStore>(store),
      as<AuditLog>(audit),
      as<UnitOfWork>(uow),
    );

  beforeEach(() => {
    trace.length = 0;
    vi.clearAllMocks();
    current = conversation();
    batch = [purged(1000)];
    committed = false;
  });

  it('owner check and reauthentication before any write; the S3 delete only after the COMMIT', async () => {
    const r = await useCase().execute(ana, SPACE, CONV, 'ok');
    expect(trace).toEqual([
      'find',
      'verify',
      'lock',
      'purgeMessages',
      'purgeAttachments',
      'deleteVersions:after-commit',
    ]);
    expect(attachments.purgeTrash).toHaveBeenCalledWith(
      scope,
      CONV,
      MAX_CONVERSATION_PURGE_ATTACHMENTS,
    );
    expect(r).toEqual({
      purgedMessages: 2,
      purgedAttachments: 1,
      purgedBytes: 1300,
      remainingAttachments: 5,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'conversation.trash_emptied',
        metadata: {
          conversationId: CONV,
          spaceId: SPACE,
          purgedMessages: 2,
          purgedAttachments: 1,
          purgedBytes: 1300,
        },
      }),
    );
  });

  it('a participant who is not the owner: 403 before the reauthentication (no Argon2 spent)', async () => {
    current = conversation(BIA);
    await expect(
      useCase().execute(ana, SPACE, CONV, 'ok'),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(uow.run).not.toHaveBeenCalled();
  });

  it('a wrong proof writes nothing', async () => {
    await expect(
      useCase().execute(ana, SPACE, CONV, 'bad'),
    ).rejects.toBeInstanceOf(DomainValidationError);
    expect(uow.run).not.toHaveBeenCalled();
  });

  it('nothing purged: no audit, no S3 call, remaining 0 (the app loop stops)', async () => {
    messages.purgeTrash.mockResolvedValueOnce({ messages: 0, bytes: 0 });
    batch = [];
    const r = await useCase().execute(ana, SPACE, CONV, 'ok');
    expect(r.remainingAttachments).toBe(0);
    expect(audit.record).not.toHaveBeenCalled();
    expect(store.deleteVersions).not.toHaveBeenCalled();
  });

  it('a failed S3 delete never fails the request (the mark stays for the sweep)', async () => {
    store.deleteVersions.mockRejectedValueOnce(new Error('S3 down'));
    await expect(
      useCase().execute(ana, SPACE, CONV, 'ok'),
    ).resolves.toMatchObject({ purgedAttachments: 1 });
  });
});

describe('ConversationRetention', () => {
  const a = { organizationId: ORG, conversationId: newId() };
  const b = { organizationId: ORG, conversationId: newId() };
  const att = purged(700);

  it('one conversation at a time, S3 after each commit; a failing conversation does not stop the others', async () => {
    const trace: string[] = [];
    const store = {
      bypassesRowSecurity: vi.fn(async () => true),
      candidates: vi.fn(async () => [a, b]),
      purge: vi.fn(async (c: typeof a) => {
        trace.push(`purge:${c === a ? 'a' : 'b'}`);
        if (c === a) throw new Error('deadlock');
        return {
          messages: 3,
          messageBytes: 90,
          attachments: [att],
          headerPurged: true,
          more: false,
        };
      }),
    };
    const objects = {
      deleteVersions: vi.fn(async () => {
        trace.push('s3');
        return { failed: [] };
      }),
    };
    const r = await new ConversationRetention(
      as<ConversationRetentionStore>(store),
      as<ObjectStore>(objects),
    ).execute();
    expect(store.candidates).toHaveBeenCalledWith(30);
    expect(store.purge).toHaveBeenCalledWith(b, 30);
    expect(trace).toEqual(['purge:a', 'purge:b', 's3']);
    expect(objects.deleteVersions).toHaveBeenCalledWith([
      {
        key: `orgs/${ORG}/spaces/${SPACE}/conversations/${CONV}/${att.id}`,
        versionId: att.s3VersionId,
      },
    ]);
    expect(r).toEqual({
      conversations: 1,
      messages: 3,
      messageBytes: 90,
      attachments: 1,
      attachmentBytes: 700,
      removedVersions: 1,
      headers: 1,
      failed: 1,
    });
  });

  it('versions the S3 call did not delete are not counted as removed', async () => {
    const store = {
      bypassesRowSecurity: vi.fn(async () => true),
      candidates: vi.fn(async () => [b]),
      purge: vi.fn(async () => ({
        messages: 0,
        messageBytes: 0,
        attachments: [att],
        headerPurged: false,
        more: false,
      })),
    };
    const objects = {
      deleteVersions: vi.fn(async () => ({
        failed: [{ key: 'k', versionId: att.s3VersionId }],
      })),
    };
    const r = await new ConversationRetention(
      as<ConversationRetentionStore>(store),
      as<ObjectStore>(objects),
    ).execute();
    expect(r).toMatchObject({ attachments: 1, removedVersions: 0, failed: 0 });
  });

  it('bounded batches: a full batch purges the same conversation again in a new transaction, S3 after each; a full batch with no progress stops', async () => {
    const trace: string[] = [];
    const batches = [
      { messages: 2, attachments: [att], more: true, headerPurged: false },
      { messages: 1, attachments: [], more: false, headerPurged: true },
      { messages: 0, attachments: [], more: true, headerPurged: false },
    ];
    const store = {
      bypassesRowSecurity: vi.fn(async () => true),
      candidates: vi.fn(async () => [a, b]),
      purge: vi.fn(async () => {
        const next = batches.shift()!;
        trace.push(`purge:${next.messages}`);
        return { ...next, messageBytes: next.messages * 10 };
      }),
    };
    const objects = {
      deleteVersions: vi.fn(async () => {
        trace.push('s3');
        return { failed: [] };
      }),
    };
    const r = await new ConversationRetention(
      as<ConversationRetentionStore>(store),
      as<ObjectStore>(objects),
    ).execute();
    expect(trace).toEqual(['purge:2', 's3', 'purge:1', 'purge:0']);
    expect(store.purge).toHaveBeenCalledTimes(3);
    expect(r).toMatchObject({
      conversations: 2,
      messages: 3,
      messageBytes: 30,
      attachments: 1,
      headers: 1,
      failed: 0,
    });
  });

  it('a login that does not ignore RLS fails before reading anything (never a silent zero)', async () => {
    const store = {
      bypassesRowSecurity: vi.fn(async () => false),
      candidates: vi.fn(async () => [a]),
      purge: vi.fn(),
    };
    const objects = { deleteVersions: vi.fn() };
    await expect(
      new ConversationRetention(
        as<ConversationRetentionStore>(store),
        as<ObjectStore>(objects),
      ).execute(),
    ).rejects.toBeInstanceOf(RetentionLoginError);
    expect(store.candidates).not.toHaveBeenCalled();
    expect(store.purge).not.toHaveBeenCalled();
  });
});
