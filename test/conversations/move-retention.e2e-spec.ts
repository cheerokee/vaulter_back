import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import type { Response } from 'supertest';
import { ConversationRetention } from '../../src/conversations/application/conversation-retention.js';
import { ConversationRetentionSqlStore } from '../../src/conversations/infra/db/conversation-retention.sql-store.js';
import { StorageReconcileHooks } from '../../src/shared/application/storage-reconcile-hooks.js';
import { newId } from '../../src/shared/domain/id.js';
import { ObjectStore } from '../../src/storage/application/ports/object-store.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import { sealAttachment } from '../support/conversation-crypto.js';
import {
  conversationRow,
  conversationSpaceUsage,
  conversationsKit,
  hubRecipientOf,
  liveParticipants,
  messageRows,
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

function expectProblem(res: Response, status: number, type: string): void {
  if (res.status !== status || !String(res.body.type).endsWith(`/${type}`)) {
    throw new Error(
      `expected ${status} ${type}, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }
}

const GiB = 1024 ** 3;

type Conv = { id: string; keys: ConversationKeys };

async function attachmentRow(id: string) {
  const rows: {
    status: string;
    s3_version_id: string | null;
    deleted: boolean;
  }[] = await (
    await adminDataSource()
  ).query(
    `SELECT status, s3_version_id, deleted_at IS NOT NULL AS deleted FROM conversation_attachments WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Moves a tombstone (or the conversation's) back in time, on the database clock. */
async function backdate(
  table: 'conversations' | 'conversation_messages' | 'conversation_attachments',
  id: string,
  days: number,
): Promise<void> {
  await (
    await adminDataSource()
  ).query(
    `UPDATE ${table} SET deleted_at = now() - make_interval(days => $2) WHERE id = $1 AND deleted_at IS NOT NULL`,
    [id, days],
  );
}

// Mover para outro espaço, retenção de 30 dias e "esvaziar a lixeira do assunto" (spec conversations §4.2, §4.4.1)
// pela HTTP real, com a cripto real do cliente, o S3 do LocalStack e o papel de runtime; a retenção roda como o CLI
// (login dono).
describe('conversations: move, retention and trash (e2e)', () => {
  let app: INestApplication;
  const c = identityClient(() => app);
  const s = c.spaces;
  const h = hubClient(() => app);
  const hubs = hubsKit(() => app);
  const k = conversationsKit(() => app);

  let olivia: KeyedUser; // admin, Gestora dos dois espaços, dona do Hub "casa"
  let ana: KeyedUser; // membro dos dois espaços
  let bruno: KeyedUser; // membro só do espaço A
  let orgId: string;
  let spaceA: string;
  let spaceB: string;
  let casa: ClaimedHub;

  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const http = () => request(app.getHttpServer());
  const base = (sp: string, conv: string) =>
    `/spaces/${sp}/conversations/${conv}`;
  const store = () => app.get(ObjectStore);
  const key = (sp: string, conv: string, a: string) =>
    `orgs/${orgId}/spaces/${sp}/conversations/${conv}/${a}`;

  const open = async (
    owner: KeyedUser,
    sp: string,
    others: KeyedUser[],
    opts: { executor?: boolean } = {},
  ): Promise<Conv> => {
    const conv = await k.create(
      owner,
      sp,
      opts.executor ? { executor: hubRecipientOf(casa) } : {},
    );
    await expectStatus(Promise.resolve(conv.res), 201);
    if (others.length) {
      await expectStatus(
        k.share(owner, sp, conv.id, others.map(recipientOf), conv.keys),
        200,
      );
    }
    return { id: conv.id, keys: conv.keys };
  };

  const send = async (u: KeyedUser, sp: string, conv: Conv, text = 'oi') => {
    const m = await k.send(u, sp, conv.id, conv.keys, { text });
    await expectStatus(Promise.resolve(m.res), 201);
    return m.id;
  };

  const del = (u: KeyedUser, sp: string, conv: Conv, messageId: string) =>
    expectStatus(k.deleteMessage(u, sp, conv.id, messageId), 204);

  /** Intent + PUT + confirm of a sealed attachment; returns its id and size. */
  const upload = async (u: KeyedUser, sp: string, conv: Conv) => {
    const id = newId();
    const blob = await sealAttachment(
      conv.keys[conv.keys.length - 1]!,
      {
        spaceId: sp,
        conversationId: conv.id,
        recordId: id,
        keyVersion: conv.keys.length,
      },
      randomBytes(500),
    );
    const intent = await expectStatus(
      http()
        .post(`${base(sp, conv.id)}/attachments`)
        .set(bearer(u.token))
        .send({
          id,
          keyVersion: conv.keys.length,
          sizeBytes: blob.length,
          sha256: await sha256Hex(blob),
        }),
      201,
    );
    const up = intent.body.upload as {
      url: string;
      headers: Record<string, string>;
    };
    const res = await fetch(up.url, {
      method: 'PUT',
      headers: up.headers,
      body: new Uint8Array(blob),
    });
    expect(res.status).toBe(200);
    await expectStatus(
      http()
        .post(`${base(sp, conv.id)}/attachments/${id}/confirm`)
        .set(bearer(u.token)),
      200,
    );
    return { id, size: blob.length };
  };

  const deleteAttachment = (u: KeyedUser, sp: string, conv: Conv, id: string) =>
    http()
      .delete(`${base(sp, conv.id)}/attachments/${id}`)
      .set(bearer(u.token));

  const move = (
    u: KeyedUser,
    sp: string,
    from: string,
    toSpaceId: string,
    toConversationId: string,
  ) =>
    http()
      .post(`${base(sp, from)}/move`)
      .set(bearer(u.token))
      .send({ toSpaceId, toConversationId });

  const emptyTrash = (
    u: KeyedUser,
    sp: string,
    conv: string,
    currentAuthProof: string,
  ) =>
    http()
      .post(`${base(sp, conv)}/trash/empty`)
      .set(bearer(u.token))
      .send({ currentAuthProof });

  const retention = () =>
    adminDataSource().then((owner) =>
      new ConversationRetention(
        new ConversationRetentionSqlStore(owner),
        store(),
      ).execute(),
    );

  const usedBytes = async (sp: string) =>
    (
      await expectStatus(
        http().get(`/spaces/${sp}`).set(bearer(olivia.token)),
        200,
      )
    ).body.storage as { usedBytes: number; trashBytes: number };

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    olivia = await s.signUpKeyed('olivia@example.com', 'Olivia');
    ana = await s.signUpKeyed('ana@example.com', 'Ana');
    bruno = await s.signUpKeyed('bruno@example.com', 'Bruno');
    const o = await s.orgWithKit(olivia, 'Casa');
    orgId = o.orgId;
    for (const u of [ana, bruno]) await s.joinOrg(olivia, orgId, u);
    casa = await h.onboard(olivia.token, 'Casa');
    await hubs.link(olivia, casa.hubId, orgId);
    const a = await s.create(olivia, orgId, o.kit.publicKey, 'A', {
      storageQuotaBytes: GiB,
    });
    const b = await s.create(olivia, orgId, o.kit.publicKey, 'B', {
      storageQuotaBytes: GiB,
    });
    spaceA = a.spaceId;
    spaceB = b.spaceId;
    for (const [sp, spKey, members] of [
      [spaceA, a.key, [ana, bruno]],
      [spaceB, b.key, [ana]],
    ] as const) {
      for (const u of members) {
        await expectStatus(
          s.addMember(
            olivia.token,
            sp,
            recipientOf(u),
            [spKey],
            'space_editor',
          ),
          201,
        );
      }
    }
    await hubs.addSpace(olivia, casa.hubId, spaceA);
    await hubs.addSpace(olivia, casa.hubId, spaceB);
  }, 180_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
  });

  describe('move to another space', () => {
    it('with common members: the owner creates in the destination with movedFrom, re-shares only with its members, then tombstones the old one', async () => {
      const old = await open(olivia, spaceA, [ana, bruno], { executor: true });
      await send(olivia, spaceA, old);

      const moved = await k.create(olivia, spaceB, {
        executor: hubRecipientOf(casa),
        movedFrom: { spaceId: spaceA, conversationId: old.id },
      });
      const created = await expectStatus(Promise.resolve(moved.res), 201);
      expect(created.body).toMatchObject({
        spaceId: spaceB,
        ownerUserId: olivia.userId,
        executorHubId: casa.hubId,
        movedFromConversationId: old.id,
      });
      // The same create again (network retry): 200, the same conversation; the same id without `movedFrom`: 409.
      const retry = await k.create(olivia, spaceB, {
        id: moved.id,
        movedFrom: { spaceId: spaceA, conversationId: old.id },
      });
      expect(
        (await expectStatus(Promise.resolve(retry.res), 200)).body.id,
      ).toBe(moved.id);
      expectProblem(
        (await k.create(olivia, spaceB, { id: moved.id })).res,
        409,
        'conversation-id-conflict',
      );
      const target: Conv = { id: moved.id, keys: moved.keys };
      // Ana is a member of the destination; Bruno is not and stays out.
      await expectStatus(
        k.share(olivia, spaceB, target.id, [recipientOf(ana)], target.keys),
        200,
      );
      expectProblem(
        await k.share(
          olivia,
          spaceB,
          target.id,
          [recipientOf(bruno)],
          target.keys,
        ),
        422,
        'participant-not-space-member',
      );
      await send(olivia, spaceB, target, 'reenviada');

      await expectStatus(move(olivia, spaceA, old.id, spaceB, target.id), 204);
      expect((await conversationRow(old.id))!.deleted).toBe(true);
      // Old participants lose it (the sync carries the conversation tombstone); the new one is alive.
      expectProblem(
        await k.get(ana, spaceA, old.id),
        404,
        'conversation-not-found',
      );
      await expectStatus(k.get(ana, spaceB, target.id), 200);
      expect(await liveParticipants(target.id)).toEqual(
        [olivia.userId, ana.userId].sort(),
      );
      // Idempotent.
      await expectStatus(move(olivia, spaceA, old.id, spaceB, target.id), 204);
      const audit: { metadata: Record<string, unknown> }[] = await (
        await adminDataSource()
      ).query(
        `SELECT metadata FROM audit_logs WHERE action = 'conversation.moved' AND organization_id = $1`,
        [orgId],
      );
      expect(audit.map((a) => a.metadata)).toContainEqual({
        conversationId: old.id,
        spaceId: spaceA,
        toConversationId: target.id,
        toSpaceId: spaceB,
        toOrganizationId: orgId,
      });
    });

    it('without common members: only the owner goes, and the executor is chosen again (or none)', async () => {
      const old = await open(olivia, spaceA, [bruno], { executor: true });
      const moved = await k.create(olivia, spaceB, {
        movedFrom: { spaceId: spaceA, conversationId: old.id },
      });
      const created = await expectStatus(Promise.resolve(moved.res), 201);
      expect(created.body.executorHubId).toBeNull();
      expectProblem(
        await k.share(
          olivia,
          spaceB,
          moved.id,
          [recipientOf(bruno)],
          moved.keys,
        ),
        422,
        'participant-not-space-member',
      );
      await expectStatus(move(olivia, spaceA, old.id, spaceB, moved.id), 204);
      expect(await liveParticipants(moved.id)).toEqual([olivia.userId]);
      expect((await conversationRow(old.id))!.deleted).toBe(true);
      expectProblem(
        await k.get(bruno, spaceA, old.id),
        404,
        'conversation-not-found',
      );
    });

    it('only the owner moves, to another space, to the conversation created from this one', async () => {
      const old = await open(olivia, spaceA, [ana]);
      // A participant who is not the owner.
      expectProblem(
        (
          await k.create(ana, spaceB, {
            movedFrom: { spaceId: spaceA, conversationId: old.id },
          })
        ).res,
        403,
        'not-conversation-owner',
      );
      // Not a participant of that conversation (here: an unknown id): the same 404 as always.
      expectProblem(
        (
          await k.create(ana, spaceB, {
            movedFrom: { spaceId: spaceA, conversationId: newId() },
          })
        ).res,
        404,
        'conversation-not-found',
      );
      // The same space.
      expectProblem(
        (
          await k.create(olivia, spaceA, {
            movedFrom: { spaceId: spaceA, conversationId: old.id },
          })
        ).res,
        422,
        'conversation-move-invalid',
      );
      // Completing with a conversation that was not created from this one.
      const unrelated = await open(olivia, spaceB, []);
      expectProblem(
        await move(olivia, spaceA, old.id, spaceB, unrelated.id),
        422,
        'conversation-move-invalid',
      );
      const moved = await k.create(olivia, spaceB, {
        movedFrom: { spaceId: spaceA, conversationId: old.id },
      });
      await expectStatus(Promise.resolve(moved.res), 201);
      // Ana does not participate in the new one: 404; once she does, she is still not the owner: 403.
      expectProblem(
        await move(ana, spaceA, old.id, spaceB, moved.id),
        404,
        'conversation-not-found',
      );
      await expectStatus(
        k.share(olivia, spaceB, moved.id, [recipientOf(ana)], moved.keys),
        200,
      );
      expectProblem(
        await move(ana, spaceA, old.id, spaceB, moved.id),
        403,
        'not-conversation-owner',
      );
      expect((await conversationRow(old.id))!.deleted).toBe(false);
      await expectStatus(move(olivia, spaceA, old.id, spaceB, moved.id), 204);
    });
  });

  describe('retention (30 days, database clock)', () => {
    it('nulls only what was deleted more than 30 days ago, takes it out of the usage and the bucket, and is idempotent', async () => {
      const conv = await open(olivia, spaceA, [ana]);
      const m1 = await send(olivia, spaceA, conv, 'velha');
      const m2 = await send(ana, spaceA, conv, 'recente');
      const m3 = await send(olivia, spaceA, conv, 'viva');
      await del(olivia, spaceA, conv, m1);
      await del(ana, spaceA, conv, m2);
      const a1 = await upload(olivia, spaceA, conv);
      const a2 = await upload(olivia, spaceA, conv);
      await expectStatus(deleteAttachment(olivia, spaceA, conv, a1.id), 204);
      await expectStatus(deleteAttachment(olivia, spaceA, conv, a2.id), 204);
      await backdate('conversation_messages', m1, 31);
      await backdate('conversation_messages', m2, 29);
      await backdate('conversation_attachments', a1.id, 31);
      await backdate('conversation_attachments', a2.id, 10);

      // A conversation whose last participant left 31 days ago: invisible to every runtime context.
      const gone = await open(olivia, spaceA, []);
      const n1 = await send(olivia, spaceA, gone, 'esquecida');
      const b1 = await upload(olivia, spaceA, gone);
      await expectStatus(k.leave(olivia, spaceA, gone.id), 204);
      await backdate('conversations', gone.id, 31);

      const bytes = async (conversationId: string, id: string) =>
        (await messageRows(conversationId)).find((r) => r.id === id)!
          .body_bytes;
      const m1Bytes = await bytes(conv.id, m1);
      const n1Bytes = await bytes(gone.id, n1);
      const usageBefore = await conversationSpaceUsage(spaceA);
      const storageBefore = await usedBytes(spaceA);

      const result = await retention();
      expect(result).toMatchObject({
        messages: 2,
        messageBytes: m1Bytes + n1Bytes,
        attachments: 2,
        attachmentBytes: a1.size + b1.size,
        removedVersions: 2,
        headers: 1,
        failed: 0,
      });

      const rows = await messageRows(conv.id);
      const body = (id: string) =>
        rows.find((r) => r.id === id)!.encrypted_body;
      expect(body(m1)).toBeNull();
      expect(body(m2)).not.toBeNull();
      expect(body(m3)).not.toBeNull();
      const goneRows = await messageRows(gone.id);
      expect(goneRows.find((r) => r.id === n1)).toMatchObject({
        encrypted_body: null,
        deleted: true,
      });
      const header: { encrypted_header: string | null }[] = await (
        await adminDataSource()
      ).query(`SELECT encrypted_header FROM conversations WHERE id = $1`, [
        gone.id,
      ]);
      expect(header[0]!.encrypted_header).toBeNull();

      expect(await attachmentRow(a1.id)).toMatchObject({ status: 'purged' });
      expect(await attachmentRow(a2.id)).toMatchObject({ status: 'committed' });
      expect(await attachmentRow(b1.id)).toMatchObject({
        status: 'purged',
        deleted: true,
      });
      expect(await store().listVersions(key(spaceA, conv.id, a1.id))).toEqual(
        [],
      );
      expect(await store().listVersions(key(spaceA, gone.id, b1.id))).toEqual(
        [],
      );
      expect(
        await store().listVersions(key(spaceA, conv.id, a2.id)),
      ).toHaveLength(1);

      // The usage counter follows (m1 was trash; n1 counted as used until now).
      const usageAfter = await conversationSpaceUsage(spaceA);
      expect(usageAfter.bodyBytes).toBe(
        usageBefore.bodyBytes - m1Bytes - n1Bytes,
      );
      expect(usageAfter.trashBytes).toBe(usageBefore.trashBytes - m1Bytes);
      const storageAfter = await usedBytes(spaceA);
      expect(storageAfter.usedBytes).toBe(
        storageBefore.usedBytes - m1Bytes - n1Bytes - a1.size - b1.size,
      );
      expect(storageAfter.trashBytes).toBe(
        storageBefore.trashBytes - m1Bytes - a1.size,
      );

      // The preflight: the owner login ignores RLS here; the runtime login does not (FORCE RLS would hide every row).
      expect(
        await new ConversationRetentionSqlStore(
          await adminDataSource(),
        ).bypassesRowSecurity(),
      ).toBe(true);
      expect(
        await new ConversationRetentionSqlStore(
          app.get(DataSource),
        ).bypassesRowSecurity(),
      ).toBe(false);

      // Nothing more to do.
      expect(await retention()).toMatchObject({
        conversations: 0,
        messages: 0,
        attachments: 0,
        headers: 0,
      });
    });
  });

  describe("emptying the conversation's trash", () => {
    it('only the owner, with reauthentication; the Gestor reaches neither this trash nor these bytes through the space trash', async () => {
      // Ana's conversation with Bruno: Olivia (Gestora, admin) does not participate.
      const conv = await open(ana, spaceA, [bruno]);
      const m1 = await send(ana, spaceA, conv, 'apagar');
      const m2 = await send(bruno, spaceA, conv, 'apagar também');
      const m3 = await send(ana, spaceA, conv, 'fica');
      await del(ana, spaceA, conv, m1);
      await del(bruno, spaceA, conv, m2);
      const x1 = await upload(ana, spaceA, conv);
      const x2 = await upload(ana, spaceA, conv);
      // Only the uploader deletes an attachment; unknown: 404; again: 204.
      expectProblem(
        await deleteAttachment(bruno, spaceA, conv, x1.id),
        403,
        'not-conversation-owner',
      );
      expectProblem(
        await deleteAttachment(ana, spaceA, conv, newId()),
        404,
        'attachment-not-found',
      );
      await expectStatus(deleteAttachment(ana, spaceA, conv, x1.id), 204);
      await expectStatus(deleteAttachment(ana, spaceA, conv, x1.id), 204);
      expect(await attachmentRow(x1.id)).toMatchObject({
        status: 'committed',
        deleted: true,
      });

      // The Gestor: the same 404 as anyone outside; her space trash does not touch the conversation.
      expectProblem(
        await emptyTrash(olivia, spaceA, conv.id, olivia.account.authProof),
        404,
        'conversation-not-found',
      );
      const spaceTrash = await expectStatus(
        http()
          .post(`/spaces/${spaceA}/backup/trash/empty`)
          .set(bearer(olivia.token))
          .send({ currentAuthProof: olivia.account.authProof }),
        200,
      );
      expect(spaceTrash.body.purgedVersions).toBe(0);
      // A participant who is not the owner.
      expectProblem(
        await emptyTrash(bruno, spaceA, conv.id, bruno.account.authProof),
        403,
        'not-conversation-owner',
      );
      // A wrong proof: nothing purged.
      expectProblem(
        await emptyTrash(ana, spaceA, conv.id, bruno.account.authProof),
        422,
        'current-auth-proof-invalid',
      );
      const before = await messageRows(conv.id);
      expect(before.filter((r) => r.encrypted_body !== null)).toHaveLength(3);

      // The S3 delete fails this time: the index is already purged, the mark stays for the sweep.
      const spy = vi
        .spyOn(store(), 'deleteVersions')
        .mockRejectedValueOnce(new Error('S3 down'));
      const bytesOf = (id: string) =>
        before.find((r) => r.id === id)!.body_bytes;
      const emptied = await expectStatus(
        emptyTrash(ana, spaceA, conv.id, ana.account.authProof),
        200,
      );
      expect(emptied.body).toEqual({
        purgedMessages: 2,
        purgedAttachments: 1,
        purgedBytes: bytesOf(m1) + bytesOf(m2) + x1.size,
        remainingAttachments: 0,
      });
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
      const after = await messageRows(conv.id);
      const body = (id: string) =>
        after.find((r) => r.id === id)!.encrypted_body;
      expect(body(m1)).toBeNull();
      expect(body(m2)).toBeNull();
      expect(body(m3)).not.toBeNull();
      expect(await attachmentRow(x1.id)).toMatchObject({ status: 'purged' });
      expect(await attachmentRow(x2.id)).toMatchObject({ status: 'committed' });
      expect(
        await store().listVersions(key(spaceA, conv.id, x1.id)),
      ).toHaveLength(1);

      // The reconcile sweep removes what the S3 call left; the live attachment stays.
      await app.get(StorageReconcileHooks).run(0);
      expect(await store().listVersions(key(spaceA, conv.id, x1.id))).toEqual(
        [],
      );
      expect(
        await store().listVersions(key(spaceA, conv.id, x2.id)),
      ).toHaveLength(1);

      // Nothing left: zeros, and the loop stops.
      expect(
        (
          await expectStatus(
            emptyTrash(ana, spaceA, conv.id, ana.account.authProof),
            200,
          )
        ).body,
      ).toEqual({
        purgedMessages: 0,
        purgedAttachments: 0,
        purgedBytes: 0,
        remainingAttachments: 0,
      });
    });
  });

  it('the executor hub deletes only its own attachments', async () => {
    const conv = await open(olivia, spaceA, [], { executor: true });
    const hubToken = await h.authenticate(casa);
    const id = newId();
    const blob = await sealAttachment(
      conv.keys[0]!,
      { spaceId: spaceA, conversationId: conv.id, recordId: id, keyVersion: 1 },
      randomBytes(200),
    );
    const hubBase = `/hub/conversations/${conv.id}/attachments`;
    const intent = await expectStatus(
      http()
        .post(hubBase)
        .set(bearer(hubToken))
        .send({
          id,
          keyVersion: 1,
          sizeBytes: blob.length,
          sha256: await sha256Hex(blob),
        }),
      201,
    );
    const up = intent.body.upload as {
      url: string;
      headers: Record<string, string>;
    };
    expect(
      (
        await fetch(up.url, {
          method: 'PUT',
          headers: up.headers,
          body: new Uint8Array(blob),
        })
      ).status,
    ).toBe(200);
    await expectStatus(
      http().post(`${hubBase}/${id}/confirm`).set(bearer(hubToken)),
      200,
    );
    const personal = await upload(olivia, spaceA, conv);
    expectProblem(
      await http().delete(`${hubBase}/${personal.id}`).set(bearer(hubToken)),
      403,
      'not-conversation-owner',
    );
    await expectStatus(
      http().delete(`${hubBase}/${id}`).set(bearer(hubToken)),
      204,
    );
    await expectStatus(
      http().delete(`${hubBase}/${id}`).set(bearer(hubToken)),
      204,
    );
    expect(await attachmentRow(id)).toMatchObject({
      status: 'committed',
      deleted: true,
    });
    expect(await attachmentRow(personal.id)).toMatchObject({ deleted: false });
  });
});
