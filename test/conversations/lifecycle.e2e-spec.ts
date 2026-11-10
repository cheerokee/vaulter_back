import type { INestApplication } from '@nestjs/common';
import type request from 'supertest';
import { ConversationMessage } from '../../src/conversations/domain/conversation-message.js';
import { ConversationMessageRepository } from '../../src/conversations/domain/conversation-message.repository.js';
import { newId } from '../../src/shared/domain/id.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import {
  newConversationKey,
  openHeader,
  sealMessage,
} from '../support/conversation-crypto.js';
import {
  bulkSpaceReaders,
  conversationRow,
  conversationsKit,
  fakeWrappedKey,
  hubRecipientOf,
  liveGrants,
  liveParticipants,
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

function expectProblem(
  res: request.Response,
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

const sorted = (xs: string[]) => [...xs].sort();

// Ciclo do assunto (spec conversations §4.1–4.2) pela HTTP real, com a cifra real do cliente e do Hub e o papel de
// runtime (RLS valendo). Review Focus 3, 4 e 5 do plano.
describe('conversations lifecycle (e2e)', () => {
  let app: INestApplication;
  const c = identityClient(() => app);
  const s = c.spaces;
  const h = hubClient(() => app);
  const hubs = hubsKit(() => app);
  const k = conversationsKit(() => app);

  let olivia: KeyedUser; // admin, Gestora do espaço, dona do Hub "casa"
  let ana: KeyedUser; // editora do espaço
  let bruno: KeyedUser; // leitor do espaço
  let paulo: KeyedUser; // editor do espaço, dono do Hub "paulo"
  let zeca: KeyedUser; // membro da organização, fora do espaço
  let orgId: string;
  let kitPublicKey: string;
  let spaceId: string;
  let casa: ClaimedHub; // Hub da Olivia, com o espaço instalado
  let pauloHub: ClaimedHub; // Hub do Paulo, com o espaço instalado
  let bare: ClaimedHub; // Hub da Olivia, vinculado, sem o espaço

  const token = (hub: ClaimedHub) => h.authenticate(hub);

  /** A space with olivia (manager) and the given members, installed on the given hubs. */
  const newSpace = async (
    name: string,
    members: [KeyedUser, string][],
    installOn: [KeyedUser, ClaimedHub][] = [],
  ) => {
    const sp = await s.create(olivia, orgId, kitPublicKey, name);
    await expectStatus(Promise.resolve(sp.res), 201);
    for (const [u, role] of members) {
      await expectStatus(
        s.addMember(olivia.token, sp.spaceId, recipientOf(u), [sp.key], role),
        201,
      );
    }
    for (const [owner, hub] of installOn) {
      await hubs.addSpace(owner, hub.hubId, sp.spaceId);
    }
    return { spaceId: sp.spaceId, key: sp.key };
  };

  const pendingMessage = async (
    author: KeyedUser,
    conversationId: string,
    convSpaceId: string,
    key: Uint8Array,
  ) => {
    const id = newId();
    const body = Buffer.from(
      await sealMessage(
        key,
        { spaceId: convSpaceId, conversationId, recordId: id, keyVersion: 1 },
        new TextEncoder().encode('liga a luz'),
      ),
    ).toString('base64url');
    const now = new Date();
    await app.get(ConversationMessageRepository).insertIfAbsent(
      { organizationId: orgId, actor: { kind: 'user', userId: author.userId } },
      ConversationMessage.create({
        id,
        organizationId: orgId,
        conversationId,
        author: { kind: 'user', userId: author.userId },
        keyVersion: 1,
        encryptedBody: body,
        replacesMessageId: null,
        sentAt: now,
        now,
      }),
    );
    return id;
  };

  const messagePending = async (id: string) => {
    const rows = await (
      await adminDataSource()
    ).query(`SELECT pending FROM conversation_messages WHERE id = $1`, [id]);
    return (rows[0] as { pending: boolean }).pending;
  };

  const auditActions = async (conversationId: string) => {
    const rows: { action: string }[] = await (
      await adminDataSource()
    ).query(
      `SELECT action FROM audit_logs WHERE metadata->>'conversationId' = $1 ORDER BY created_at, id`,
      [conversationId],
    );
    return rows.map((r) => r.action);
  };

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    olivia = await s.signUpKeyed('olivia@example.com', 'Olivia');
    ana = await s.signUpKeyed('ana@example.com', 'Ana');
    bruno = await s.signUpKeyed('bruno@example.com', 'Bruno');
    paulo = await s.signUpKeyed('paulo@example.com', 'Paulo');
    zeca = await s.signUpKeyed('zeca@example.com', 'Zeca');
    const o = await s.orgWithKit(olivia, 'Casa');
    orgId = o.orgId;
    kitPublicKey = o.kit.publicKey;
    for (const u of [ana, bruno, paulo, zeca])
      await s.joinOrg(olivia, orgId, u);

    casa = await h.onboard(olivia.token, 'Casa');
    pauloHub = await h.onboard(paulo.token, 'Paulo');
    bare = await h.onboard(olivia.token, 'Vazio');
    await hubs.link(olivia, casa.hubId, orgId);
    await hubs.link(olivia, bare.hubId, orgId);
    const pl = await hubs.link(paulo, pauloHub.hubId, orgId);
    if (pl.status !== 'approved') {
      await hubs.approve(olivia, pauloHub.hubId, orgId);
    }
    const sp = await newSpace(
      'Projetos',
      [
        [ana, 'space_editor'],
        [bruno, 'space_reader'],
        [paulo, 'space_editor'],
      ],
      [
        [olivia, casa],
        [paulo, pauloHub],
      ],
    );
    spaceId = sp.spaceId;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  });

  describe('create', () => {
    it('a person opens one with her own hub as executor; the copies open and the header decrypts', async () => {
      const conv = await k.create(olivia, spaceId, {
        executor: hubRecipientOf(casa),
      });
      const created = await expectStatus(Promise.resolve(conv.res), 201);
      expect(created.body).toMatchObject({
        id: conv.id,
        organizationId: orgId,
        spaceId,
        createdByUserId: olivia.userId,
        ownerUserId: olivia.userId,
        executorHubId: casa.hubId,
        state: 'na_fila',
        currentKeyVersion: 1,
        keyRotationRequired: false,
        participants: [{ userId: olivia.userId, joinedAt: expect.any(String) }],
      });
      expect(created.body.keys).toHaveLength(1);
      const mine = await k.open(olivia, created.body.keys[0].wrappedKey);
      expect(Buffer.from(mine)).toEqual(Buffer.from(conv.keys[0]!));
      const plain = await openHeader(
        mine,
        { spaceId, conversationId: conv.id, recordId: conv.id, keyVersion: 1 },
        Buffer.from(created.body.encryptedHeader, 'base64url'),
      );
      expect(JSON.parse(new TextDecoder().decode(plain))).toEqual({
        title: 'Assunto',
      });

      const seen = await expectStatus(
        k.hubGet(await token(casa), conv.id),
        200,
      );
      expect(seen.body.keys).toEqual([
        { keyVersion: 1, wrappedKey: expect.any(String) },
      ]);
      expect(
        Buffer.from(await k.hubOpens(casa, seen.body.keys[0].wrappedKey)),
      ).toEqual(Buffer.from(conv.keys[0]!));

      // Resending the same create is idempotent.
      const again = await k.create(olivia, spaceId, { id: conv.id });
      expect(again.res.status).toBe(200);
      expect(again.res.body.id).toBe(conv.id);
    });

    it('a hub of another owner, or without the space installed, is refused: 422 executor-invalid', async () => {
      const other = await k.create(olivia, spaceId, {
        executor: hubRecipientOf(pauloHub),
      });
      expectProblem(other.res, 422, 'executor-invalid');
      const notInstalled = await k.create(olivia, spaceId, {
        executor: hubRecipientOf(bare),
      });
      expectProblem(notInstalled.res, 422, 'executor-invalid');
      expect(await conversationRow(other.id)).toBeNull();
    });

    it('a non-member of the space gets 404 space-not-found', async () => {
      const conv = await k.create(zeca, spaceId);
      expectProblem(conv.res, 404, 'space-not-found');
    });

    it('the executor hub opens one in the name of a space member, sealing for her and for its owner', async () => {
      const hubToken = await token(casa);
      const conv = await k.hubCreate(
        casa,
        hubToken,
        spaceId,
        recipientOf(ana),
        [recipientOf(ana), recipientOf(olivia)],
      );
      const created = await expectStatus(Promise.resolve(conv.res), 201);
      expect(created.body).toMatchObject({
        ownerUserId: ana.userId,
        createdByUserId: ana.userId,
        executorHubId: casa.hubId,
        state: 'aviso',
      });
      expect(sorted(await liveParticipants(conv.id))).toEqual(
        sorted([ana.userId, olivia.userId]),
      );
      const forAna = await expectStatus(k.get(ana, spaceId, conv.id), 200);
      expect(
        Buffer.from(await k.open(ana, forAna.body.keys[0].wrappedKey)),
      ).toEqual(Buffer.from(conv.keys[0]!));

      // The hub owner must participate (executor rule).
      const withoutOwner = await k.hubCreate(
        casa,
        hubToken,
        spaceId,
        recipientOf(ana),
        [recipientOf(ana)],
      );
      expectProblem(withoutOwner.res, 422, 'executor-invalid');
      // The person must be a member of the space.
      const outsider = await k.hubCreate(
        casa,
        hubToken,
        spaceId,
        recipientOf(zeca),
        [recipientOf(zeca), recipientOf(olivia)],
      );
      expectProblem(outsider.res, 422, 'participant-not-space-member');
      // A hub without the space installed cannot.
      const bareConv = await k.hubCreate(
        bare,
        await token(bare),
        spaceId,
        recipientOf(olivia),
        [recipientOf(olivia)],
      );
      expectProblem(bareConv.res, 422, 'executor-invalid');
    });
  });

  describe('participants', () => {
    it('any participant shares with space members (every version); a non-member is 422', async () => {
      const conv = await k.create(olivia, spaceId);
      await expectStatus(Promise.resolve(conv.res), 201);
      await expectStatus(
        k.share(olivia, spaceId, conv.id, [recipientOf(ana)], conv.keys),
        200,
      );
      // Ana (participant, not owner) shares with Bruno.
      const shared = await expectStatus(
        k.share(ana, spaceId, conv.id, [recipientOf(bruno)], conv.keys),
        200,
      );
      expect(
        sorted(
          (shared.body.participants as { userId: string }[]).map(
            (p) => p.userId,
          ),
        ),
      ).toEqual(sorted([olivia.userId, ana.userId, bruno.userId]));
      const forBruno = await expectStatus(k.get(bruno, spaceId, conv.id), 200);
      expect(
        Buffer.from(await k.open(bruno, forBruno.body.keys[0].wrappedKey)),
      ).toEqual(Buffer.from(conv.keys[0]!));

      expectProblem(
        await k.share(olivia, spaceId, conv.id, [recipientOf(zeca)], conv.keys),
        422,
        'participant-not-space-member',
      );
      // Missing a version: 409 key-versions-mismatch.
      expectProblem(
        await k.shareRaw(olivia, spaceId, conv.id, {
          participants: [{ userId: paulo.userId, grants: [] }],
        }),
        422,
        'validation-failed',
      );
      expectProblem(
        await k.shareRaw(olivia, spaceId, conv.id, {
          participants: [
            {
              userId: paulo.userId,
              grants: [{ keyVersion: 2, wrappedKey: fakeWrappedKey() }],
            },
          ],
        }),
        409,
        'key-versions-mismatch',
      );
      // A space member who does not participate: 404, as for a nonexistent conversation.
      expectProblem(
        await k.share(paulo, spaceId, conv.id, [recipientOf(paulo)], conv.keys),
        404,
        'conversation-not-found',
      );
      expectProblem(
        await k.get(paulo, spaceId, conv.id),
        404,
        'conversation-not-found',
      );
      expect(await auditActions(conv.id)).toContain('conversation.shared');
    });

    it('share with the whole space: exactly the members who do not participate yet', async () => {
      const conv = await k.create(ana, spaceId);
      await expectStatus(Promise.resolve(conv.res), 201);
      const wrong = expectProblem(
        await k.share(
          ana,
          spaceId,
          conv.id,
          [recipientOf(olivia)],
          conv.keys,
          'participants/space',
        ),
        409,
        'conversation-share-mismatch',
      );
      expect(sorted(wrong.missingUserIds as string[])).toEqual(
        sorted([bruno.userId, paulo.userId]),
      );
      await expectStatus(
        k.share(
          ana,
          spaceId,
          conv.id,
          [olivia, bruno, paulo].map(recipientOf),
          conv.keys,
          'participants/space',
        ),
        200,
      );
      expect(sorted(await liveParticipants(conv.id))).toEqual(
        sorted([olivia, ana, bruno, paulo].map((u) => u.userId)),
      );
    });

    it('the 51st participant is refused: 409 conversation-participant-limit', async () => {
      const big = await newSpace('Grande', []);
      const people = await bulkSpaceReaders(app, orgId, big.spaceId, 50);
      const conv = await k.create(olivia, big.spaceId);
      await expectStatus(Promise.resolve(conv.res), 201);
      const body = (ids: string[]) => ({
        participants: ids.map((userId) => ({
          userId,
          grants: [{ keyVersion: 1, wrappedKey: fakeWrappedKey() }],
        })),
      });
      await expectStatus(
        k.shareRaw(olivia, big.spaceId, conv.id, body(people.slice(0, 49))),
        200,
      );
      expectProblem(
        await k.shareRaw(olivia, big.spaceId, conv.id, body(people.slice(49))),
        409,
        'conversation-participant-limit',
      );
      expect(await liveParticipants(conv.id)).toHaveLength(50);
    }, 60_000);

    it('only the owner removes; the removed person loses the conversation and a rotation is required', async () => {
      const conv = await k.create(olivia, spaceId);
      await expectStatus(Promise.resolve(conv.res), 201);
      await expectStatus(
        k.share(
          olivia,
          spaceId,
          conv.id,
          [ana, bruno].map(recipientOf),
          conv.keys,
        ),
        200,
      );
      expectProblem(
        await k.remove(ana, spaceId, conv.id, bruno.userId),
        403,
        'not-conversation-owner',
      );
      await expectStatus(k.remove(olivia, spaceId, conv.id, bruno.userId), 204);
      expectProblem(
        await k.get(bruno, spaceId, conv.id),
        404,
        'conversation-not-found',
      );
      expect(await conversationRow(conv.id)).toMatchObject({
        key_rotation_required: true,
      });
      expect((await liveGrants(conv.id)).map(([, w]) => w)).not.toContain(
        bruno.userId,
      );
      expect(await auditActions(conv.id)).toContain(
        'conversation.participant_removed',
      );
    });
  });

  describe('state', () => {
    it('the owner archives and reopens; the executor moves the work states; anything else is 403', async () => {
      const conv = await k.create(olivia, spaceId, {
        executor: hubRecipientOf(casa),
      });
      await expectStatus(Promise.resolve(conv.res), 201);
      await expectStatus(
        k.share(olivia, spaceId, conv.id, [recipientOf(ana)], conv.keys),
        200,
      );
      const hubToken = await token(casa);

      const working = await expectStatus(
        k.hubSetState(hubToken, conv.id, 'trabalhando'),
        200,
      );
      expect(working.body.state).toBe('trabalhando');
      expectProblem(
        await k.setState(olivia, spaceId, conv.id, 'concluido'),
        403,
        'not-conversation-owner',
      );
      expectProblem(
        await k.setState(ana, spaceId, conv.id, 'arquivado'),
        403,
        'not-conversation-owner',
      );
      expectProblem(
        await k.hubSetState(hubToken, conv.id, 'arquivado'),
        403,
        'not-conversation-owner',
      );
      await expectStatus(
        k.setState(olivia, spaceId, conv.id, 'arquivado'),
        200,
      );
      const reopened = await expectStatus(
        k.setState(olivia, spaceId, conv.id, 'na_fila'),
        200,
      );
      expect(reopened.body.state).toBe('na_fila');
      expectProblem(
        await k.setState(olivia, spaceId, conv.id, 'dormindo'),
        422,
        'validation-failed',
      );
    });
  });

  // Review Focus 3: someone leaves; their copies of the new version never exist; only the active set gets it.
  describe('leave and key rotation', () => {
    it('after a participant leaves, writing needs a rotation for exactly the active set', async () => {
      const conv = await k.create(olivia, spaceId, {
        executor: hubRecipientOf(casa),
      });
      await expectStatus(Promise.resolve(conv.res), 201);
      await expectStatus(
        k.share(
          olivia,
          spaceId,
          conv.id,
          [ana, bruno].map(recipientOf),
          conv.keys,
        ),
        200,
      );
      // Without a pending rotation, only the owner rotates (manual).
      const v2 = await newConversationKey();
      expectProblem(
        await k.rotate(
          bruno,
          spaceId,
          conv.id,
          await k.rotationBody(2, v2, [olivia, ana, bruno].map(recipientOf), [
            hubRecipientOf(casa),
          ]),
        ),
        409,
        'key-rotation-not-required',
      );

      await expectStatus(k.leave(ana, spaceId, conv.id), 204);
      expectProblem(
        await k.get(ana, spaceId, conv.id),
        404,
        'conversation-not-found',
      );
      expect(await conversationRow(conv.id)).toMatchObject({
        key_rotation_required: true,
        owner_user_id: olivia.userId,
        executor_hub_id: casa.hubId,
      });
      expect(await liveGrants(conv.id)).toEqual(
        [
          [1, olivia.userId],
          [1, bruno.userId],
          [1, casa.hubId],
        ].sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
      );

      // Sealing for the person who left (or forgetting the executor): 409 key-rotation-mismatch with the ids.
      const wrong = expectProblem(
        await k.rotate(
          bruno,
          spaceId,
          conv.id,
          await k.rotationBody(
            2,
            v2,
            [olivia, ana, bruno].map(recipientOf),
            [],
          ),
        ),
        409,
        'key-rotation-mismatch',
      );
      expect(wrong).toMatchObject({
        unexpectedUserIds: [ana.userId],
        missingHubIds: [casa.hubId],
      });
      expectProblem(
        await k.rotate(
          bruno,
          spaceId,
          conv.id,
          await k.rotationBody(3, v2, [olivia, bruno].map(recipientOf), [
            hubRecipientOf(casa),
          ]),
        ),
        409,
        'conversation-key-version-stale',
      );

      // A remaining participant (not the owner) rotates.
      const rotated = await expectStatus(
        k.rotate(
          bruno,
          spaceId,
          conv.id,
          await k.rotationBody(2, v2, [olivia, bruno].map(recipientOf), [
            hubRecipientOf(casa),
          ]),
        ),
        200,
      );
      expect(rotated.body).toMatchObject({
        currentKeyVersion: 2,
        keyRotationRequired: false,
      });
      const v2Holders = (await liveGrants(conv.id))
        .filter(([v]) => v === 2)
        .map(([, w]) => w);
      expect(sorted(v2Holders)).toEqual(
        sorted([olivia.userId, bruno.userId, casa.hubId]),
      );
      const hubView = await expectStatus(
        k.hubGet(await token(casa), conv.id),
        200,
      );
      expect(
        Buffer.from(await k.hubOpens(casa, hubView.body.keys[1].wrappedKey)),
      ).toEqual(Buffer.from(v2));
      // Ana cannot come back by herself.
      expectProblem(
        await k.share(
          ana,
          spaceId,
          conv.id,
          [recipientOf(ana)],
          [...conv.keys, v2],
        ),
        404,
        'conversation-not-found',
      );
    });

    it('the executor hub rotates a pending rotation too', async () => {
      const conv = await k.create(olivia, spaceId, {
        executor: hubRecipientOf(casa),
      });
      await expectStatus(Promise.resolve(conv.res), 201);
      await expectStatus(
        k.share(olivia, spaceId, conv.id, [recipientOf(ana)], conv.keys),
        200,
      );
      await expectStatus(k.leave(ana, spaceId, conv.id), 204);
      const v2 = await newConversationKey();
      const rotated = await expectStatus(
        k.hubRotate(
          await token(casa),
          conv.id,
          await k.rotationBody(
            2,
            v2,
            [recipientOf(olivia)],
            [hubRecipientOf(casa)],
          ),
        ),
        200,
      );
      expect(rotated.body.keyRotationRequired).toBe(false);
    });

    it('the owner leaves: the oldest participant becomes the owner; the last one ends the conversation', async () => {
      const conv = await k.create(olivia, spaceId);
      await expectStatus(Promise.resolve(conv.res), 201);
      await expectStatus(
        k.share(olivia, spaceId, conv.id, [recipientOf(bruno)], conv.keys),
        200,
      );
      await expectStatus(
        k.share(olivia, spaceId, conv.id, [recipientOf(ana)], conv.keys),
        200,
      );
      await expectStatus(k.leave(olivia, spaceId, conv.id), 204);
      expect(await conversationRow(conv.id)).toMatchObject({
        owner_user_id: bruno.userId,
        deleted: false,
      });
      await expectStatus(k.leave(bruno, spaceId, conv.id), 204);
      await expectStatus(k.leave(ana, spaceId, conv.id), 204);
      expect(await conversationRow(conv.id)).toMatchObject({
        deleted: true,
        participant_user_ids: [],
      });
      expect(await liveGrants(conv.id)).toEqual([]);
    });
  });

  describe('executor', () => {
    it('the owner changes the executor: copies of every version for the new hub, rotation required, old hub out', async () => {
      const conv = await k.create(olivia, spaceId, {
        executor: hubRecipientOf(casa),
      });
      await expectStatus(Promise.resolve(conv.res), 201);
      // Paulo's hub only after Paulo participates.
      expectProblem(
        await k.changeExecutor(
          olivia,
          spaceId,
          conv.id,
          hubRecipientOf(pauloHub),
          conv.keys,
        ),
        422,
        'executor-invalid',
      );
      await expectStatus(
        k.share(olivia, spaceId, conv.id, [recipientOf(paulo)], conv.keys),
        200,
      );
      expectProblem(
        await k.changeExecutor(
          paulo,
          spaceId,
          conv.id,
          hubRecipientOf(pauloHub),
          conv.keys,
        ),
        403,
        'not-conversation-owner',
      );
      const changed = await expectStatus(
        k.changeExecutor(
          olivia,
          spaceId,
          conv.id,
          hubRecipientOf(pauloHub),
          conv.keys,
        ),
        200,
      );
      expect(changed.body).toMatchObject({
        executorHubId: pauloHub.hubId,
        keyRotationRequired: true,
      });
      expectProblem(
        await k.hubGet(await token(casa), conv.id),
        404,
        'conversation-not-found',
      );
      const seen = await expectStatus(
        k.hubGet(await token(pauloHub), conv.id),
        200,
      );
      expect(
        Buffer.from(await k.hubOpens(pauloHub, seen.body.keys[0].wrappedKey)),
      ).toEqual(Buffer.from(conv.keys[0]!));
      expect(await auditActions(conv.id)).toContain(
        'conversation.executor_changed',
      );
    });

    // Review Focus 4: the executor stops being valid with pending messages.
    const lossCase = async (
      lose: (conv: { id: string; keys: ConversationKeys }) => Promise<void>,
      hub: ClaimedHub,
      owner: KeyedUser,
      convSpaceId: string,
    ) => {
      const conv = await k.create(owner, convSpaceId, {
        executor: hubRecipientOf(hub),
      });
      await expectStatus(Promise.resolve(conv.res), 201);
      const hubToken = await token(hub);
      const pending = await pendingMessage(
        owner,
        conv.id,
        convSpaceId,
        conv.keys[0]!,
      );
      await lose(conv);
      expect(await conversationRow(conv.id)).toMatchObject({
        executor_hub_id: null,
        key_rotation_required: true,
        deleted: false,
      });
      expect(await messagePending(pending)).toBe(true);
      expect((await liveGrants(conv.id)).map(([, w]) => w)).not.toContain(
        hub.hubId,
      );
      const after = await k.hubGet(hubToken, conv.id);
      expect([401, 404]).toContain(after.status);
      return conv;
    };

    it('the space is removed from the hub: executor null, messages stay pending, the hub loses access', async () => {
      const own = await newSpace('Removido', [], [[olivia, casa]]);
      const keep = await k.create(olivia, spaceId, {
        executor: hubRecipientOf(casa),
      });
      await expectStatus(Promise.resolve(keep.res), 201);
      const conv = await lossCase(
        async () => {
          await hubs.removeSpace(olivia, casa.hubId, own.spaceId);
        },
        casa,
        olivia,
        own.spaceId,
      );
      expect(await auditActions(conv.id)).toContain(
        'conversation.executor_lost',
      );
      // A conversation of another space on the same hub keeps its executor.
      expect(await conversationRow(keep.id)).toMatchObject({
        executor_hub_id: casa.hubId,
      });
    });

    it('the organization is unlinked from the hub: same', async () => {
      const hub = await h.onboard(olivia.token, 'Desvincula');
      await hubs.link(olivia, hub.hubId, orgId);
      await hubs.addSpace(olivia, hub.hubId, spaceId);
      await lossCase(
        async () => {
          await hubs.unlink(olivia, hub.hubId, orgId);
        },
        hub,
        olivia,
        spaceId,
      );
    });

    it('the hub is deregistered: same', async () => {
      const hub = await h.onboard(olivia.token, 'Desregistra');
      await hubs.link(olivia, hub.hubId, orgId);
      await hubs.addSpace(olivia, hub.hubId, spaceId);
      await lossCase(
        async () => {
          await hubs.deregister(olivia, hub.hubId);
        },
        hub,
        olivia,
        spaceId,
      );
    });
  });

  // Review Focus 5: the owner leaves the space.
  describe('leaving the space', () => {
    it('the only participant leaves the space: the conversation becomes a tombstone', async () => {
      const sp = await newSpace('Saida', [[bruno, 'space_reader']]);
      const conv = await k.create(bruno, sp.spaceId);
      await expectStatus(Promise.resolve(conv.res), 201);
      await expectStatus(
        c
          .http()
          .delete(`/spaces/${sp.spaceId}/members/${bruno.userId}`)
          .set(c.bearer(olivia.token)),
        204,
      );
      expect(await conversationRow(conv.id)).toMatchObject({
        deleted: true,
        participant_user_ids: [],
      });
    });

    it('with others: the oldest becomes the owner, and the executor of the leaver leaves too', async () => {
      const sp = await newSpace(
        'Sucessao',
        [
          [ana, 'space_editor'],
          [paulo, 'space_editor'],
        ],
        [[paulo, pauloHub]],
      );
      const conv = await k.create(paulo, sp.spaceId, {
        executor: hubRecipientOf(pauloHub),
      });
      await expectStatus(Promise.resolve(conv.res), 201);
      await expectStatus(
        k.share(paulo, sp.spaceId, conv.id, [recipientOf(ana)], conv.keys),
        200,
      );
      await expectStatus(
        c.http().post(`/spaces/${sp.spaceId}/leave`).set(c.bearer(paulo.token)),
        204,
      );
      expect(await conversationRow(conv.id)).toMatchObject({
        owner_user_id: ana.userId,
        executor_hub_id: null,
        key_rotation_required: true,
        deleted: false,
        participant_user_ids: [ana.userId],
      });
      expect((await liveGrants(conv.id)).map(([, w]) => w)).toEqual([
        ana.userId,
      ]);
      expectProblem(
        await k.hubGet(await token(pauloHub), conv.id),
        404,
        'conversation-not-found',
      );
    });
  });
});
