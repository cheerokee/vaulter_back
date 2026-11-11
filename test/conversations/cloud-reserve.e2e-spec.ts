import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Response } from 'supertest';
import { DataSource } from 'typeorm';
import { ServerKeyring } from '../../src/cloud/application/ports/server-keyring.js';
import { CloudConversationExecutor } from '../../src/conversations/application/cloud-conversation-executor.js';
import {
  CloudReservePendingHooks,
  type CloudReservePendingContext,
} from '../../src/shared/application/cloud-reserve-pending-hooks.js';
import { newId } from '../../src/shared/domain/id.js';
import { runWithContext } from '../../src/shared/infra/db/unit-of-work.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import { openMessage, sealMessage } from '../support/conversation-crypto.js';
import {
  conversationRow,
  conversationsKit,
  fakeWrappedKey,
  hubRecipientOf,
  liveGrants,
  messageRows,
  type ConversationKeys,
} from '../support/conversations-kit.js';
import { hubClient } from '../support/hub-client.js';
import { hubsKit, type ClaimedHub } from '../support/hubs-kit.js';
import {
  expectStatus,
  identityClient,
  recipientOf,
  type KeyedUser,
} from '../support/identity-client.js';
import { cloudSwitch } from '../support/space-manifest.js';

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
  return res.body as Record<string, unknown>;
}

type Item = {
  type: string;
  deleted: boolean;
  data: Record<string, unknown>;
};

// A nuvem como executor de reserva dos assuntos (spec active-cloud §4.3, Task 6 do plano), pela HTTP real, com a cifra
// real do cliente, do Hub e da chave do servidor (ServerKeyring do LocalStack/KMS), e o papel de runtime (RLS valendo).
// Review Focus 4: troca de chave do assunto sem a cópia do servidor -> 409 com `missingServer`, nada gravado.
describe('conversations: the cloud as reserve executor (e2e)', () => {
  let app: INestApplication;
  const c = identityClient(() => app);
  const s = c.spaces;
  const h = hubClient(() => app);
  const hubs = hubsKit(() => app);
  const k = conversationsKit(() => app);
  const cloud = cloudSwitch(() => app);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  let olivia: KeyedUser; // admin, Gestora dos espaços, dona do Hub "casa"
  let ana: KeyedUser; // editora do espaço ativo
  let bruno: KeyedUser; // leitor do espaço ativo, nunca participa
  let orgId: string;
  let active: string; // espaço em nuvem ativa
  let plain: string; // espaço só cifrado
  let activeKeys: Uint8Array[];
  let casa: ClaimedHub;
  let casaToken: string;
  let serverPk: string;
  let preexisting: { id: string; keys: ConversationKeys }; // criado antes de ligar a nuvem

  const executor = () => app.get(CloudConversationExecutor);
  const signals: CloudReservePendingContext[] = [];

  const create = async (
    user: KeyedUser,
    spaceId: string,
    opts: { server?: boolean; executor?: boolean } = {},
  ) => {
    const conv = await k.create(user, spaceId, {
      ...(opts.server === false ? {} : { serverPublicKey: serverPk }),
      ...(opts.executor ? { executor: hubRecipientOf(casa) } : {}),
    });
    await expectStatus(Promise.resolve(conv.res), 201);
    return { id: conv.id, keys: conv.keys, body: conv.res.body };
  };

  const feed = async (user: KeyedUser) =>
    (
      await expectStatus(
        http()
          .get('/conversations/changes')
          .query({ since: 0 })
          .set(bearer(user.token)),
        200,
      )
    ).body.items as Item[];

  const hubFeed = async () =>
    (
      await expectStatus(
        http()
          .get('/hub/conversations/changes')
          .query({ since: 0 })
          .set(bearer(casaToken)),
        200,
      )
    ).body.items as Item[];

  const serverCopies = async (conversationId: string) =>
    (await liveGrants(conversationId)).filter(([, who]) => who === 'server');

  /** Raw SQL as the runtime login with the cloud's context for `spaceId`. */
  const asCloud = (spaceId: string, sql: string, params: unknown[] = []) =>
    runWithContext(
      app.get(DataSource),
      { organizationId: orgId, cloudExecutorSpaceId: spaceId },
      (m) => m.query(sql, params) as Promise<Record<string, unknown>[]>,
    );

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    app.get(CloudReservePendingHooks).register({
      name: 'test.signals',
      onPending: async (ctx) => {
        signals.push(ctx);
      },
    });
    olivia = await s.signUpKeyed('olivia@example.com', 'Olivia');
    ana = await s.signUpKeyed('ana@example.com', 'Ana');
    bruno = await s.signUpKeyed('bruno@example.com', 'Bruno');
    const o = await s.orgWithKit(olivia, 'Casa');
    orgId = o.orgId;
    for (const u of [ana, bruno]) await s.joinOrg(olivia, orgId, u);
    casa = await h.onboard(olivia.token, 'Casa');
    await hubs.link(olivia, casa.hubId, orgId);
    casaToken = await h.authenticate(casa);

    const a = await s.create(olivia, orgId, o.kit.publicKey, 'Ativo');
    await expectStatus(Promise.resolve(a.res), 201);
    active = a.spaceId;
    activeKeys = [a.key];
    for (const [u, role] of [
      [ana, 'space_editor'],
      [bruno, 'space_reader'],
    ] as const) {
      await expectStatus(
        s.addMember(olivia.token, active, recipientOf(u), activeKeys, role),
        201,
      );
    }
    await hubs.addSpace(olivia, casa.hubId, active);
    const p = await s.create(olivia, orgId, o.kit.publicKey, 'Cifrado');
    await expectStatus(Promise.resolve(p.res), 201);
    plain = p.spaceId;

    serverPk = await s.serverPublicKey(olivia.token);
    // Before the space goes to the active cloud: no reserve, no server copy.
    preexisting = await create(olivia, active, { server: false });
    await expectStatus(
      k.share(
        olivia,
        active,
        preexisting.id,
        [recipientOf(ana)],
        preexisting.keys,
      ),
      200,
    );
    await cloud.switchOn(olivia, orgId, active, activeKeys);
  }, 240_000);

  afterAll(async () => {
    app?.get(CloudReservePendingHooks).unregister('test.signals');
    await app?.close();
  });

  describe('creating', () => {
    it('in a space in the active cloud, without the server copy: 422 cloud-reserve-copy-required, nothing created', async () => {
      const id = newId();
      const res = await k.create(olivia, active, { id });
      expectProblem(res.res, 422, 'cloud-reserve-copy-required');
      expect(await conversationRow(id)).toBeNull();
    });

    it('a copy sealed for another key (or garbage): 422 server-copy-invalid, nothing created', async () => {
      const id = newId();
      const wrongKey = await k.create(olivia, active, {
        id,
        serverPublicKey: ana.account.publicKey,
      });
      expectProblem(wrongKey.res, 422, 'server-copy-invalid');
      expect(await conversationRow(id)).toBeNull();
    });

    it('outside the active cloud a server copy is refused: 422 cloud-reserve-unavailable', async () => {
      const res = await k.create(olivia, plain, { serverPublicKey: serverPk });
      expectProblem(res.res, 422, 'cloud-reserve-unavailable');
    });

    it('with the copy: born with the cloud reserve; the server copy opens with the server key and never reaches a feed', async () => {
      const conv = await create(olivia, active, { executor: true });
      expect(conv.body.cloudReserve).toBe(true);
      expect(conv.body.cloudReserveDeclined).toBe(false);
      expect(await serverCopies(conv.id)).toEqual([[1, 'server']]);
      // The caller's view carries only the caller's own copy.
      expect(conv.body.keys).toHaveLength(1);

      const read = await executor().read(orgId, active, conv.id);
      expect(read?.serverKeyCopies.map((g) => g.keyVersion)).toEqual([1]);
      const opened = await app
        .get(ServerKeyring)
        .openSealed(read!.serverKeyCopies[0]!.wrappedKey);
      expect(Buffer.from(opened).equals(Buffer.from(conv.keys[0]!))).toBe(true);

      for (const items of [await feed(olivia), await hubFeed()]) {
        const mine = items.filter((i) => i.data.conversationId === conv.id);
        const grants = mine.filter((i) => i.type === 'conversation_key_grant');
        expect(grants.length).toBeGreaterThan(0);
        for (const g of grants) {
          expect(g.data.userId ?? g.data.hubId).toBeTruthy();
        }
        const head = items.find(
          (i) => i.type === 'conversation' && i.data.id === conv.id,
        );
        expect(head?.data.cloudReserve).toBe(true);
      }
    });
  });

  describe('key rotation (Review Focus 4)', () => {
    it('without the server copy while the reserve is on: 409 key-rotation-mismatch with missingServer, nothing written; with it: the server gets v2', async () => {
      const conv = await create(olivia, active);
      const key2 = activeKeys[0]!; // any 32-byte key works as the new version
      const without = await k.rotationBody(2, key2, [recipientOf(olivia)], []);
      const res = await k.rotate(olivia, active, conv.id, without);
      const body = expectProblem(res, 409, 'key-rotation-mismatch');
      expect(body.missingServer).toBe(true);
      expect((await conversationRow(conv.id))?.current_key_version).toBe(1);
      expect(await liveGrants(conv.id)).toHaveLength(2);
      expect(await serverCopies(conv.id)).toEqual([[1, 'server']]);

      const withServer = await k.rotationBody(
        2,
        key2,
        [recipientOf(olivia)],
        [],
        serverPk,
      );
      await expectStatus(k.rotate(olivia, active, conv.id, withServer), 200);
      expect(await serverCopies(conv.id)).toEqual([
        [1, 'server'],
        [2, 'server'],
      ]);
    });

    it('a server copy without the reserve: 409 key-rotation-mismatch with unexpectedServer', async () => {
      const conv = await create(olivia, plain, { server: false });
      const body = await k.rotationBody(
        2,
        conv.keys[0]!,
        [recipientOf(olivia)],
        [],
        serverPk,
      );
      const res = await k.rotate(olivia, plain, conv.id, body);
      expect(
        expectProblem(res, 409, 'key-rotation-mismatch').unexpectedServer,
      ).toBe(true);
    });
  });

  describe('answering (what the cloud responder builds on)', () => {
    it('a person sends: signal for the cloud; the cloud acks first, the Hub ack is 404 (discard), the cloud answers with the key opened from its copy', async () => {
      const conv = await create(olivia, active, { executor: true });
      signals.length = 0;
      const sent = await k.send(olivia, active, conv.id, conv.keys, {
        text: 'como aprovo a compra?',
      });
      await expectStatus(Promise.resolve(sent.res), 201);
      expect(signals).toEqual([
        {
          organizationId: orgId,
          spaceId: active,
          conversationId: conv.id,
          messageId: sent.id,
          reason: 'sent',
        },
      ]);

      // The history the cloud reads opens with the key from the server copy.
      const read = (await executor().read(orgId, active, conv.id))!;
      const key = await app
        .get(ServerKeyring)
        .openSealed(read.serverKeyCopies[0]!.wrappedKey);
      const msg = read.messages.find((m) => m.id === sent.id)!;
      expect(msg.pending).toBe(true);
      const plaintext = await openMessage(
        key,
        {
          spaceId: active,
          conversationId: conv.id,
          recordId: msg.id,
          keyVersion: 1,
        },
        Buffer.from(msg.encryptedBody, 'base64url'),
      );
      expect(new TextDecoder().decode(plaintext)).toBe('como aprovo a compra?');

      expect(await executor().ack(orgId, active, conv.id, sent.id)).toBe(
        'acked',
      );
      expect(await executor().ack(orgId, active, conv.id, sent.id)).toBe(
        'taken',
      );
      expectProblem(
        await k.hubAck(casaToken, conv.id, sent.id),
        404,
        'message-not-found',
      );

      const answerId = newId();
      const answer = await executor().send(orgId, active, conv.id, {
        id: answerId,
        keyVersion: 1,
        encryptedBody: Buffer.from(
          await sealMessage(
            key,
            {
              spaceId: active,
              conversationId: conv.id,
              recordId: answerId,
              keyVersion: 1,
            },
            new TextEncoder().encode('assim: ...'),
          ),
        ).toString('base64url'),
        replacesMessageId: null,
      });
      key.fill(0);
      expect(answer.created).toBe(true);
      expect(answer.view).toMatchObject({
        authorCloud: true,
        authorUserId: null,
        authorHubId: null,
        pending: false,
      });
      const items = await feed(olivia);
      const fromCloud = items.find(
        (i) => i.type === 'conversation_message' && i.data.id === answerId,
      );
      expect(fromCloud?.data.authorCloud).toBe(true);
      const asked = items.find(
        (i) => i.type === 'conversation_message' && i.data.id === sent.id,
      );
      expect(asked?.data.pending).toBe(false);
    });

    it('the Hub acks first: the cloud gives up (taken)', async () => {
      const conv = await create(olivia, active, { executor: true });
      const sent = await k.send(olivia, active, conv.id, conv.keys);
      await expectStatus(k.hubAck(casaToken, conv.id, sent.id), 200);
      expect(await executor().ack(orgId, active, conv.id, sent.id)).toBe(
        'taken',
      );
    });

    it('the cloud context opens only the live conversations with the reserve in its own space', async () => {
      const withReserve = await create(olivia, active);
      const noReserve = await create(olivia, plain, { server: false });
      const ids = (await asCloud(active, `SELECT id FROM conversations`)).map(
        (r) => r.id,
      );
      expect(ids).toContain(withReserve.id);
      expect(ids).not.toContain(preexisting.id);
      expect(ids).not.toContain(noReserve.id);
      expect(await asCloud(plain, `SELECT id FROM conversations`)).toEqual([]);
      // Nor the children of another conversation.
      const msgs = await asCloud(
        active,
        `SELECT DISTINCT conversation_id FROM conversation_messages`,
      );
      expect(msgs.map((r) => r.conversation_id)).not.toContain(preexisting.id);
      // It never writes copies or participations: an insert is refused, an update reaches no row.
      await expect(
        asCloud(
          active,
          `INSERT INTO conversation_key_grants (organization_id, conversation_id, key_version, server_recipient, wrapped_key)
           VALUES ($1, $2, 9, true, $3)`,
          [orgId, withReserve.id, fakeWrappedKey()],
        ),
      ).rejects.toMatchObject({ driverError: { code: '42501' } });
      const updated = (await asCloud(
        active,
        `UPDATE conversation_participants SET updated_at = now() WHERE conversation_id = $1`,
        [withReserve.id],
      )) as unknown as [unknown[], number];
      expect(updated[1]).toBe(0);
      expect(await executor().read(orgId, plain, noReserve.id)).toBeNull();
      expect(await executor().read(orgId, active, preexisting.id)).toBeNull();
    });
  });

  describe('switching the reserve per conversation', () => {
    it('a participant switches it on for a conversation that existed before the space went to the cloud', async () => {
      // A participant (not the owner) opens it in the app and sends the copies of every version.
      const res = await k.setCloudReserve(
        ana,
        active,
        preexisting.id,
        preexisting.keys,
        serverPk,
      );
      expect(
        (await expectStatus(Promise.resolve(res), 200)).body.cloudReserve,
      ).toBe(true);
      expect(await serverCopies(preexisting.id)).toEqual([[1, 'server']]);
      expect(
        await executor().read(orgId, active, preexisting.id),
      ).not.toBeNull();
    });

    it('outside the active cloud: 422 cloud-reserve-unavailable', async () => {
      const conv = await create(olivia, plain, { server: false });
      expectProblem(
        await k.setCloudReserve(olivia, plain, conv.id, conv.keys, serverPk),
        422,
        'cloud-reserve-unavailable',
      );
    });

    it('switching it on needs the copy of EVERY version: 409 key-versions-mismatch, nothing written', async () => {
      const conv = await create(olivia, active);
      await expectStatus(
        k.setCloudReserve(olivia, active, conv.id, conv.keys, null),
        200,
      );
      const key2 = new Uint8Array(32).fill(7);
      await expectStatus(
        k.rotate(
          olivia,
          active,
          conv.id,
          await k.rotationBody(2, key2, [recipientOf(olivia)], []),
        ),
        200,
      );
      expectProblem(
        await k.setCloudReserve(olivia, active, conv.id, conv.keys, serverPk),
        409,
        'key-versions-mismatch',
      );
      expect(await serverCopies(conv.id)).toEqual([]);
      const on = await k.setCloudReserve(
        olivia,
        active,
        conv.id,
        [...conv.keys, key2],
        serverPk,
      );
      expect(
        (await expectStatus(Promise.resolve(on), 200)).body.cloudReserve,
      ).toBe(true);
      expect(await serverCopies(conv.id)).toEqual([
        [1, 'server'],
        [2, 'server'],
      ]);
    });

    it('the owner switches it off: copies deleted, rotation pending, what the cloud took without answering goes back to pending, and the cloud loses access; only the owner switches it on again', async () => {
      const conv = await create(olivia, active, { executor: true });
      await expectStatus(
        k.share(olivia, active, conv.id, [recipientOf(ana)], conv.keys),
        200,
      );
      const sent = await k.send(ana, active, conv.id, conv.keys);
      expect(await executor().ack(orgId, active, conv.id, sent.id)).toBe(
        'acked',
      );

      expectProblem(
        await k.setCloudReserve(ana, active, conv.id, conv.keys, null),
        403,
        'not-conversation-owner',
      );
      const off = await expectStatus(
        k.setCloudReserve(olivia, active, conv.id, conv.keys, null),
        200,
      );
      expect(off.body).toMatchObject({
        cloudReserve: false,
        cloudReserveDeclined: true,
        keyRotationRequired: true,
      });
      expect(await serverCopies(conv.id)).toEqual([]);
      const rows = await (
        await adminDataSource()
      ).query(
        `SELECT count(*)::int AS n FROM conversation_key_grants WHERE conversation_id = $1 AND server_recipient`,
        [conv.id],
      );
      expect(rows[0].n).toBe(0); // deleted, not a tombstone
      expect(
        (await messageRows(conv.id)).find((m) => m.id === sent.id)?.pending,
      ).toBe(true);
      expect(await executor().read(orgId, active, conv.id)).toBeNull();
      expect(await executor().ack(orgId, active, conv.id, sent.id)).toBe(
        'unavailable',
      );
      await expect(
        executor().send(orgId, active, conv.id, {
          id: newId(),
          keyVersion: 1,
          encryptedBody: Buffer.alloc(60, 1).toString('base64url'),
          replacesMessageId: null,
        }),
      ).rejects.toMatchObject({ code: 'conversation-not-found' });
      // The Hub takes it now.
      await expectStatus(k.hubAck(casaToken, conv.id, sent.id), 200);

      // A participant does not switch it back on; the owner does.
      expectProblem(
        await k.setCloudReserve(ana, active, conv.id, conv.keys, serverPk),
        403,
        'not-conversation-owner',
      );
      const on = await expectStatus(
        k.setCloudReserve(olivia, active, conv.id, conv.keys, serverPk),
        200,
      );
      expect(on.body.cloudReserve).toBe(true);
      expect(on.body.cloudReserveDeclined).toBe(false);
    });

    it('the last participant leaves: the tombstone takes the reserve and the server copies with it', async () => {
      const conv = await create(olivia, active);
      await expectStatus(k.leave(olivia, active, conv.id), 204);
      expect((await conversationRow(conv.id))?.deleted).toBe(true);
      expect(await serverCopies(conv.id)).toEqual([]);
    });
  });

  describe('switching the space cloud off', () => {
    it('every conversation of the space loses the reserve: server copies deleted, rotation pending, the cloud reads nothing', async () => {
      const a = await create(olivia, active);
      const b = await create(olivia, active, { executor: true });
      await cloud.switchOff(olivia, active);
      for (const conv of [a, b, preexisting]) {
        expect(await serverCopies(conv.id)).toEqual([]);
        const row = await conversationRow(conv.id);
        expect(row?.key_rotation_required).toBe(true);
      }
      const left = await (
        await adminDataSource()
      ).query(
        `SELECT count(*)::int AS n FROM conversation_key_grants g JOIN conversations c ON c.id = g.conversation_id
          WHERE c.space_id = $1 AND g.server_recipient`,
        [active],
      );
      expect(left[0].n).toBe(0);
      const reserve = await (
        await adminDataSource()
      ).query(
        `SELECT count(*)::int AS n FROM conversations WHERE space_id = $1 AND cloud_reserve`,
        [active],
      );
      expect(reserve[0].n).toBe(0);
      expect(await executor().conversationIds(orgId, active)).toEqual([]);
      expect(await executor().read(orgId, active, a.id)).toBeNull();
      const audits = await (
        await adminDataSource()
      ).query(
        `SELECT count(*)::int AS n FROM audit_logs WHERE organization_id = $1 AND action = 'conversation.cloud_reserve_lost'`,
        [orgId],
      );
      expect(audits[0].n).toBeGreaterThanOrEqual(3);
      // Not the owner's choice: a participant may switch it on again once the space is back in the cloud.
      expect(
        (await expectStatus(k.get(olivia, active, a.id), 200)).body
          .cloudReserveDeclined,
      ).toBe(false);
      // Creating again needs no server copy now.
      await create(olivia, active, { server: false });
    });
  });
});
