import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Response } from 'supertest';
import { StorageReconcileHooks } from '../../src/shared/application/storage-reconcile-hooks.js';
import { newId } from '../../src/shared/domain/id.js';
import { ObjectStore } from '../../src/storage/application/ports/object-store.js';
import { UnitOfWork } from '../../src/shared/infra/db/unit-of-work.js';
import { CONVERSATION_SYNC_FEED } from '../../src/shared/infra/db/migration-helpers.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import {
  newConversationKey,
  openAttachment,
  sealAttachment,
} from '../support/conversation-crypto.js';
import {
  conversationsKit,
  hubRecipientOf,
  type ConversationKeys,
} from '../support/conversations-kit.js';
import { hubClient } from '../support/hub-client.js';
import { sha256Hex } from '../support/hub-crypto.js';
import { hubsKit, type ClaimedHub } from '../support/hubs-kit.js';
import {
  expectStatus,
  identityClient,
  recipientOf,
  type KeyedUser,
} from '../support/identity-client.js';

function expectProblem(
  res: Response,
  status: number,
  type: string,
): Record<string, unknown> {
  if (res.status !== status || !String(res.body.type).endsWith(`/${type}`)) {
    throw new Error(
      `expected ${status} ${type}, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }
  expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  return res.body as Record<string, unknown>;
}

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

type Upload = { url: string; headers: Record<string, string> };

/** What the app/hub does with the presigned PUT: the exact bytes and the returned headers, verbatim. */
async function put(upload: Upload, blob: Uint8Array): Promise<void> {
  const res = await fetch(upload.url, {
    method: 'PUT',
    headers: upload.headers,
    body: new Uint8Array(blob),
  });
  expect(res.status, await res.text()).toBe(200);
}

async function attachmentRow(id: string) {
  const rows = await (
    await adminDataSource()
  ).query(
    `SELECT status, s3_version_id, s3_write_started_at, space_id, uploaded_by_user_id, uploaded_by_hub_id
       FROM conversation_attachments WHERE id = $1`,
    [id],
  );
  return (
    (rows[0] as
      | {
          status: string;
          s3_version_id: string | null;
          s3_write_started_at: Date | null;
          space_id: string;
          uploaded_by_user_id: string | null;
          uploaded_by_hub_id: string | null;
        }
      | undefined) ?? null
  );
}

// Anexos cifrados dos assuntos (spec conversations §4.4) pela HTTP real, com o S3 do LocalStack, a cifra real do
// cliente/Hub (`sealAttachment`/`openAttachment`) e o papel de runtime (RLS valendo): intenção (PUT assinado),
// confirmação (HEAD + cópia no servidor, diário), URL de download, uso do espaço e a varredura do reparo.
describe('conversation attachments (e2e)', () => {
  let app: INestApplication;
  const c = identityClient(() => app);
  const s = c.spaces;
  const h = hubClient(() => app);
  const hubs = hubsKit(() => app);
  const k = conversationsKit(() => app);

  let olivia: KeyedUser; // admin, Gestora, dona do Hub "casa"
  let ana: KeyedUser; // editora do espaço, participante
  let bruno: KeyedUser; // leitor do espaço, NÃO participa
  let paulo: KeyedUser; // dono de outro Hub com o espaço instalado
  let orgId: string;
  let kitPublicKey: string;
  let spaceId: string;
  let casa: ClaimedHub;
  let pauloHub: ClaimedHub;

  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const http = () => request(app.getHttpServer());
  const userBase = (sp: string, conv: string) =>
    `/spaces/${sp}/conversations/${conv}/attachments`;
  const hubBase = (conv: string) => `/hub/conversations/${conv}/attachments`;

  const conversation = async (others: KeyedUser[] = [ana], sp = spaceId) => {
    const conv = await k.create(olivia, sp, { executor: hubRecipientOf(casa) });
    await expectStatus(Promise.resolve(conv.res), 201);
    if (others.length) {
      await expectStatus(
        k.share(olivia, sp, conv.id, others.map(recipientOf), conv.keys),
        200,
      );
    }
    return { id: conv.id, keys: conv.keys as ConversationKeys };
  };

  /** A sealed attachment (AD bound to the space, conversation, attachment id and key version) and its request body. */
  const sealed = async (
    conv: { id: string; keys: ConversationKeys },
    plaintext: Uint8Array = randomBytes(300),
    sp = spaceId,
  ) => {
    const id = newId();
    const keyVersion = conv.keys.length;
    const blob = await sealAttachment(
      conv.keys[keyVersion - 1]!,
      { spaceId: sp, conversationId: conv.id, recordId: id, keyVersion },
      plaintext,
    );
    return {
      id,
      plaintext,
      blob,
      body: {
        id,
        keyVersion,
        sizeBytes: blob.length,
        sha256: await sha256Hex(blob),
      },
    };
  };

  const usedBytes = async (sp = spaceId) =>
    (
      await expectStatus(
        http().get(`/spaces/${sp}`).set(bearer(olivia.token)),
        200,
      )
    ).body.storage.usedBytes as number;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    olivia = await s.signUpKeyed('olivia@example.com', 'Olivia');
    ana = await s.signUpKeyed('ana@example.com', 'Ana');
    bruno = await s.signUpKeyed('bruno@example.com', 'Bruno');
    paulo = await s.signUpKeyed('paulo@example.com', 'Paulo');
    const o = await s.orgWithKit(olivia, 'Casa');
    orgId = o.orgId;
    kitPublicKey = o.kit.publicKey;
    for (const u of [ana, bruno, paulo]) await s.joinOrg(olivia, orgId, u);
    casa = await h.onboard(olivia.token, 'Casa');
    pauloHub = await h.onboard(paulo.token, 'Paulo');
    await hubs.link(olivia, casa.hubId, orgId);
    const pl = await hubs.link(paulo, pauloHub.hubId, orgId);
    if (pl.status !== 'approved') {
      await hubs.approve(olivia, pauloHub.hubId, orgId);
    }
    const sp = await s.create(olivia, orgId, kitPublicKey, 'Projetos', {
      storageQuotaBytes: GiB,
    });
    await expectStatus(Promise.resolve(sp.res), 201);
    spaceId = sp.spaceId;
    for (const [u, role] of [
      [ana, 'space_editor'],
      [bruno, 'space_reader'],
      [paulo, 'space_editor'],
    ] as const) {
      await expectStatus(
        s.addMember(olivia.token, spaceId, recipientOf(u), [sp.key], role),
        201,
      );
    }
    await hubs.addSpace(olivia, casa.hubId, spaceId);
    await hubs.addSpace(paulo, pauloHub.hubId, spaceId);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  });

  // Every commit that writes a conversation table takes the feed's version lock at COMMIT (ConversationFeedCommitOrder):
  // a wait there past the storage `lock_timeout` raises 55P03 AT COMMIT, which must still be the retryable 409
  // `storage-busy`, never a 500. The lock timeout is shortened here so the test does not wait 10 s per route.
  it('a wait for the feed version lock at COMMIT past the storage lock_timeout is the retryable 409 storage-busy (intent, confirm, delete, empty trash)', async () => {
    const conv = await conversation([]);
    const intentOf = async (a: Awaited<ReturnType<typeof sealed>>) =>
      expectStatus(
        http()
          .post(userBase(spaceId, conv.id))
          .set(bearer(olivia.token))
          .send(a.body),
        201,
      );
    const uploaded = async () => {
      const a = await sealed(conv);
      await put((await intentOf(a)).body.upload as Upload, a.blob);
      return a;
    };
    const confirm = (id: string) =>
      http()
        .post(`${userBase(spaceId, conv.id)}/${id}/confirm`)
        .set(bearer(olivia.token));
    const remove = (id: string) =>
      http()
        .delete(`${userBase(spaceId, conv.id)}/${id}`)
        .set(bearer(olivia.token));
    const emptyTrash = () =>
      http()
        .post(`/spaces/${spaceId}/conversations/${conv.id}/trash/empty`)
        .set(bearer(olivia.token))
        .send({ currentAuthProof: olivia.account.authProof });

    const pending = await uploaded();
    const committed = await uploaded();
    await expectStatus(confirm(committed.id), 200);
    const trashed = await uploaded();
    await expectStatus(confirm(trashed.id), 200);
    await expectStatus(remove(trashed.id), 204);
    const fresh = await sealed(conv);

    // The one UnitOfWork instance every use case shares.
    const uow = app.get(UnitOfWork);
    const original = uow.setLockTimeout.bind(uow);
    const short = vi
      .spyOn(uow, 'setLockTimeout')
      .mockImplementation(() => original(300));
    const holder = (await adminDataSource()).createQueryRunner();
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1::bigint)', [
        CONVERSATION_SYNC_FEED.lockKey,
      ]);
      expectProblem(
        await http()
          .post(userBase(spaceId, conv.id))
          .set(bearer(olivia.token))
          .send(fresh.body),
        409,
        'storage-busy',
      );
      expectProblem(await confirm(pending.id), 409, 'storage-busy');
      expectProblem(await remove(committed.id), 409, 'storage-busy');
      expectProblem(await emptyTrash(), 409, 'storage-busy');
      expect(short).toHaveBeenCalled();
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1::bigint)', [
        CONVERSATION_SYNC_FEED.lockKey,
      ]);
      await holder.release();
      short.mockRestore();
    }
    // Retryable: the same requests succeed once the lock is free.
    await intentOf(fresh);
    await expectStatus(confirm(pending.id), 200);
    await expectStatus(remove(committed.id), 204);
    await expectStatus(emptyTrash(), 200);
  }, 60_000);

  it('a participant uploads (intent, PUT, confirm), the usage counts it, and the others and the executor download and open it', async () => {
    const conv = await conversation();
    const before = await usedBytes();
    const a = await sealed(conv, new TextEncoder().encode('foto da sala'));

    const intent = await expectStatus(
      http()
        .post(userBase(spaceId, conv.id))
        .set(bearer(ana.token))
        .send(a.body),
      201,
    );
    expect(intent.body.attachment).toMatchObject({
      id: a.id,
      conversationId: conv.id,
      keyVersion: 1,
      sizeBytes: a.blob.length,
      sha256: a.body.sha256,
      status: 'pending',
      uploadedByUserId: ana.userId,
      uploadedByHubId: null,
    });
    // The reservation already counts.
    expect(await usedBytes()).toBe(before + a.blob.length);
    await put(intent.body.upload as Upload, a.blob);

    const confirmed = await expectStatus(
      http()
        .post(`${userBase(spaceId, conv.id)}/${a.id}/confirm`)
        .set(bearer(ana.token)),
      200,
    );
    expect(confirmed.body.status).toBe('committed');
    expect(await usedBytes()).toBe(before + a.blob.length);
    const row = (await attachmentRow(a.id))!;
    expect(row).toMatchObject({
      status: 'committed',
      space_id: spaceId,
      uploaded_by_user_id: ana.userId,
    });
    // The journal mark was written before the S3 copy and stays after the commit (only the sweep clears it).
    expect(row.s3_write_started_at).not.toBeNull();
    const key = `orgs/${orgId}/spaces/${spaceId}/conversations/${conv.id}/${a.id}`;
    const store = app.get(ObjectStore);
    expect((await store.head(key))!.versionId).toBe(row.s3_version_id);

    // A retry of the confirmation: the same answer, nothing copied again.
    const again = await expectStatus(
      http()
        .post(`${userBase(spaceId, conv.id)}/${a.id}/confirm`)
        .set(bearer(ana.token)),
      200,
    );
    expect(again.body).toEqual(confirmed.body);
    expect(await store.listVersions(key)).toHaveLength(1);
    // The same intent again: 200 and no URL (already committed).
    const repeated = await expectStatus(
      http()
        .post(userBase(spaceId, conv.id))
        .set(bearer(ana.token))
        .send(a.body),
      200,
    );
    expect(repeated.body.upload).toBeNull();

    const ctx = {
      spaceId,
      conversationId: conv.id,
      recordId: a.id,
      keyVersion: 1,
    };
    const dl = await expectStatus(
      http()
        .post(`${userBase(spaceId, conv.id)}/${a.id}/download`)
        .set(bearer(olivia.token)),
      200,
    );
    expect(dl.body).toEqual({
      url: expect.any(String),
      expiresAt: expect.any(String),
    });
    const res = await fetch(dl.body.url as string);
    expect(res.status).toBe(200);
    expect(
      new TextDecoder().decode(
        await openAttachment(
          conv.keys[0]!,
          ctx,
          new Uint8Array(await res.arrayBuffer()),
        ),
      ),
    ).toBe('foto da sala');

    const hubToken = await h.authenticate(casa);
    const hubDl = await expectStatus(
      http()
        .post(`${hubBase(conv.id)}/${a.id}/download`)
        .set(bearer(hubToken)),
      200,
    );
    const viaHub = await fetch(hubDl.body.url as string);
    expect(
      Buffer.from(
        await openAttachment(
          conv.keys[0]!,
          ctx,
          new Uint8Array(await viaHub.arrayBuffer()),
        ),
      ),
    ).toEqual(Buffer.from('foto da sala'));
  });

  it('the executor hub uploads with its own token; other hubs and people outside the conversation get the same 404', async () => {
    const conv = await conversation();
    const casaToken = await h.authenticate(casa);
    const a = await sealed(conv);
    const intent = await expectStatus(
      http().post(hubBase(conv.id)).set(bearer(casaToken)).send(a.body),
      201,
    );
    expect(intent.body.attachment.uploadedByHubId).toBe(casa.hubId);
    await put(intent.body.upload as Upload, a.blob);

    // Only the one who asked confirms: Ana (a participant) cannot confirm the hub's upload.
    expectProblem(
      await http()
        .post(`${userBase(spaceId, conv.id)}/${a.id}/confirm`)
        .set(bearer(ana.token)),
      404,
      'attachment-not-found',
    );
    await expectStatus(
      http()
        .post(`${hubBase(conv.id)}/${a.id}/confirm`)
        .set(bearer(casaToken)),
      200,
    );

    // Bruno is a member of the space (memory.read), not a participant: the same 404 everywhere.
    const b = await sealed(conv);
    for (const res of [
      await http()
        .post(userBase(spaceId, conv.id))
        .set(bearer(bruno.token))
        .send(b.body),
      await http()
        .post(`${userBase(spaceId, conv.id)}/${a.id}/confirm`)
        .set(bearer(bruno.token)),
      await http()
        .post(`${userBase(spaceId, conv.id)}/${a.id}/download`)
        .set(bearer(bruno.token)),
    ]) {
      expectProblem(res, 404, 'conversation-not-found');
    }
    // Paulo's hub has the space installed but is not the executor.
    const pauloToken = await h.authenticate(pauloHub);
    for (const res of [
      await http().post(hubBase(conv.id)).set(bearer(pauloToken)).send(b.body),
      await http()
        .post(`${hubBase(conv.id)}/${a.id}/download`)
        .set(bearer(pauloToken)),
    ]) {
      expectProblem(res, 404, 'conversation-not-found');
    }
    // An attachment of another conversation through this one: 404 attachment-not-found.
    const other = await conversation();
    expectProblem(
      await http()
        .post(`${userBase(spaceId, other.id)}/${a.id}/download`)
        .set(bearer(ana.token)),
      404,
      'attachment-not-found',
    );
  });

  it('bytes other than declared, or no PUT at all: 422 upload-mismatch and nothing enters the index or the final key', async () => {
    const conv = await conversation();
    const a = await sealed(conv);
    const intent = await expectStatus(
      http()
        .post(userBase(spaceId, conv.id))
        .set(bearer(ana.token))
        .send(a.body),
      201,
    );
    const confirmPath = `${userBase(spaceId, conv.id)}/${a.id}/confirm`;
    expectProblem(
      await http().post(confirmPath).set(bearer(ana.token)),
      422,
      'upload-mismatch',
    );
    // Other bytes at the provisional key (signed for them, not for the declared ones).
    const wrong = randomBytes(a.blob.length + 7);
    const store = app.get(ObjectStore);
    const uploadKey = `orgs/${orgId}/spaces/${spaceId}/conversations/${conv.id}/uploads/${a.id}`;
    await put(
      await store.presignPut(uploadKey, {
        sizeBytes: wrong.length,
        sha256Hex: await sha256Hex(wrong),
        expiresInSeconds: 60,
      }),
      wrong,
    );
    const problem = expectProblem(
      await http().post(confirmPath).set(bearer(ana.token)),
      422,
      'upload-mismatch',
    );
    expect(problem.attachmentId).toBe(a.id);
    expect((await attachmentRow(a.id))!.status).toBe('pending');
    const key = `orgs/${orgId}/spaces/${spaceId}/conversations/${conv.id}/${a.id}`;
    expect(await store.listVersions(key)).toEqual([]);
    // The right bytes then confirm normally.
    await put(intent.body.upload as Upload, a.blob);
    await expectStatus(http().post(confirmPath).set(bearer(ana.token)), 200);
  });

  it('size: 100 MiB is accepted (reserved), one byte more is 422 attachment-too-large; the space must fit the reservations', async () => {
    const sp = await s.create(olivia, orgId, kitPublicKey, 'Pequeno', {
      storageQuotaBytes: GiB,
    });
    await expectStatus(Promise.resolve(sp.res), 201);
    await expectStatus(
      s.addMember(
        olivia.token,
        sp.spaceId,
        recipientOf(ana),
        [sp.key],
        'space_editor',
      ),
      201,
    );
    await hubs.addSpace(olivia, casa.hubId, sp.spaceId);
    const conv = await conversation([ana], sp.spaceId);
    const big = (id = newId()) => ({
      id,
      keyVersion: 1,
      sizeBytes: 100 * MiB,
      sha256: 'b'.repeat(64),
    });
    expectProblem(
      await http()
        .post(userBase(sp.spaceId, conv.id))
        .set(bearer(ana.token))
        .send({ ...big(), sizeBytes: 100 * MiB + 1 }),
      422,
      'attachment-too-large',
    );
    // 10 reservations of 100 MiB fit 1 GiB; the 11th does not (it counts every live reservation of the space).
    for (let i = 0; i < 10; i++) {
      await expectStatus(
        http()
          .post(userBase(sp.spaceId, conv.id))
          .set(bearer(ana.token))
          .send(big()),
        201,
      );
    }
    // Plus the conversation's encrypted header (ConversationHeaderUsage).
    const headerBytes = Buffer.from(
      (await expectStatus(k.get(olivia, sp.spaceId, conv.id), 200)).body
        .encryptedHeader as string,
      'base64url',
    ).length;
    expect(await usedBytes(sp.spaceId)).toBe(1000 * MiB + headerBytes);
    const full = expectProblem(
      await http()
        .post(userBase(sp.spaceId, conv.id))
        .set(bearer(ana.token))
        .send(big()),
      422,
      'space-storage-full',
    );
    expect(full.missingBytes).toBe(1100 * MiB + headerBytes - GiB);
    // The backup of the space reads the same usage (one port): a person's backup intent does not fit either.
    expectProblem(
      await http()
        .post(`/spaces/${sp.spaceId}/backup/uploads`)
        .set(bearer(ana.token))
        .send({
          items: [
            {
              objectId: newId(),
              keyVersion: 1,
              sizeBytes: 100 * MiB,
              sha256: 'c'.repeat(64),
              replacesVersionId: null,
            },
          ],
        }),
      422,
      'space-storage-full',
    );
  });

  it('a pending key rotation refuses new attachments and their confirmation (409); after the rotation a stale version is 409', async () => {
    const conv = await conversation([ana, bruno]);
    // An upload asked for (and done) before Bruno is removed.
    const early = await sealed(conv);
    const intent = await expectStatus(
      http()
        .post(userBase(spaceId, conv.id))
        .set(bearer(ana.token))
        .send(early.body),
      201,
    );
    await put(intent.body.upload as Upload, early.blob);
    await expectStatus(k.remove(olivia, spaceId, conv.id, bruno.userId), 204);
    const a = await sealed(conv);
    expectProblem(
      await http()
        .post(userBase(spaceId, conv.id))
        .set(bearer(ana.token))
        .send(a.body),
      409,
      'conversation-key-rotation-required',
    );
    // Bruno knew the key the early blob was sealed with: it cannot become content after he left.
    expectProblem(
      await http()
        .post(`${userBase(spaceId, conv.id)}/${early.id}/confirm`)
        .set(bearer(ana.token)),
      409,
      'conversation-key-rotation-required',
    );

    const v2 = await newConversationKey();
    await expectStatus(
      k.rotate(
        olivia,
        spaceId,
        conv.id,
        await k.rotationBody(2, v2, [olivia, ana].map(recipientOf), [
          hubRecipientOf(casa),
        ]),
      ),
      200,
    );
    expectProblem(
      await http()
        .post(userBase(spaceId, conv.id))
        .set(bearer(ana.token))
        .send(a.body),
      409,
      'conversation-key-version-stale',
    );
    const fresh = await sealed({ id: conv.id, keys: [...conv.keys, v2] });
    await expectStatus(
      http()
        .post(userBase(spaceId, conv.id))
        .set(bearer(ana.token))
        .send(fresh.body),
      201,
    );
  });

  it('the reconcile sweep (storage:reconcile) also repairs attachments: a stray copy with an aged mark is removed and the mark cleared', async () => {
    const conv = await conversation();
    const a = await sealed(conv);
    const intent = await expectStatus(
      http()
        .post(userBase(spaceId, conv.id))
        .set(bearer(ana.token))
        .send(a.body),
      201,
    );
    await put(intent.body.upload as Upload, a.blob);
    // What a crashed confirmation leaves: a marked pending row and a copy at the final key.
    const store = app.get(ObjectStore);
    const base = `orgs/${orgId}/spaces/${spaceId}/conversations/${conv.id}`;
    await store.copy(`${base}/uploads/${a.id}`, `${base}/${a.id}`);
    const ds = await adminDataSource();
    await ds.query(
      `UPDATE conversation_attachments SET s3_write_started_at = now() - interval '2 hours' WHERE id = $1`,
      [a.id],
    );

    const result = await app.get(StorageReconcileHooks).run(60);
    expect(result['conversations.attachments']).toEqual({
      attachments: 1,
      removedVersions: 1,
    });
    expect(await store.listVersions(`${base}/${a.id}`)).toEqual([]);
    expect((await attachmentRow(a.id))!.s3_write_started_at).toBeNull();
    expect(await app.get(StorageReconcileHooks).run(60)).toMatchObject({
      'conversations.attachments': { attachments: 0, removedVersions: 0 },
    });
    // The upload can still be confirmed normally.
    await expectStatus(
      http()
        .post(`${userBase(spaceId, conv.id)}/${a.id}/confirm`)
        .set(bearer(ana.token)),
      200,
    );
  });
});
