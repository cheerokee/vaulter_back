import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DEFAULT_KDF_PARAMS } from '../../src/identity/domain/kdf-params.js';
import { User } from '../../src/identity/domain/user.js';
import { UserRepository } from '../../src/identity/domain/user.repository.js';
import { MembershipRepository } from '../../src/organizations/domain/membership.repository.js';
import { RoleAssignmentRepository } from '../../src/organizations/domain/role-assignment.repository.js';
import { newId } from '../../src/shared/domain/id.js';
import { UnitOfWork } from '../../src/shared/infra/db/unit-of-work.js';
import { SpaceRoleRepository } from '../../src/spaces/domain/space-role.repository.js';
import { adminDataSource } from '../setup/test-app.js';
import { testRecoveryFields } from './client-crypto.js';
import {
  newConversationKey,
  openConversationKey,
  sealConversationKey,
  sealHeader,
  sealMessage,
} from './conversation-crypto.js';
import type { ClaimedHub } from './hubs-kit.js';
import type { KeyedUser, Recipient } from './identity-client.js';

/** Someone a key copy is sealed for: a person (Recipient) or a hub (its X25519 encryption key). */
export type HubRecipient = { hubId: string; publicKey: string };
export const hubRecipientOf = (hub: ClaimedHub): HubRecipient => ({
  hubId: hub.hubId,
  publicKey: hub.identity.encryptionPublicKey,
});

/** The keys of a conversation as the app holds them: keys[i] = version i + 1. */
export type ConversationKeys = Uint8Array[];

/**
 * Conversations over the real HTTP API with the REAL client crypto (copies sealed with `crypto_box_seal`, header
 * sealed with the conversation AD). User routes under `/spaces/:spaceId/conversations`, hub routes under
 * `/hub/conversations` (the hub token comes from `hubClient().authenticate`). The raw helpers return the supertest
 * response, so a spec can assert errors.
 */
export function conversationsKit(getApp: () => INestApplication) {
  const http = () => request(getApp().getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const base = (spaceId: string, id?: string) =>
    `/spaces/${spaceId}/conversations${id ? `/${id}` : ''}`;

  const header = async (
    key: Uint8Array,
    spaceId: string,
    conversationId: string,
    keyVersion = 1,
  ) =>
    Buffer.from(
      await sealHeader(
        key,
        { spaceId, conversationId, recordId: conversationId, keyVersion },
        new TextEncoder().encode(JSON.stringify({ title: 'Assunto' })),
      ),
    ).toString('base64url');

  /** Every version (keys[i] = version i + 1) sealed for one public key. */
  const allVersions = async (keys: ConversationKeys, publicKey: string) =>
    Promise.all(
      keys.map(async (key, i) => ({
        keyVersion: i + 1,
        wrappedKey: await sealConversationKey(key, publicKey),
      })),
    );

  /** A message body sealed with the conversation key (AD bound to the space, conversation, message id and version). */
  const messageBody = async (
    key: Uint8Array,
    spaceId: string,
    conversationId: string,
    messageId: string,
    keyVersion: number,
    text: string,
  ) =>
    Buffer.from(
      await sealMessage(
        key,
        { spaceId, conversationId, recordId: messageId, keyVersion },
        new TextEncoder().encode(text),
      ),
    ).toString('base64url');

  return {
    allVersions,
    messageBody,
    /**
     * A person sends a message sealed with `keys[keyVersion - 1]` (default: the last version). Returns the body sent so
     * a spec can resend exactly the same thing.
     */
    send: async (
      user: KeyedUser,
      spaceId: string,
      conversationId: string,
      keys: ConversationKeys,
      opts: {
        id?: string;
        text?: string;
        keyVersion?: number;
        replacesMessageId?: string;
      } = {},
    ) => {
      const id = opts.id ?? newId();
      const keyVersion = opts.keyVersion ?? keys.length;
      const body = {
        id,
        keyVersion,
        encryptedBody: await messageBody(
          keys[keyVersion - 1]!,
          spaceId,
          conversationId,
          id,
          keyVersion,
          opts.text ?? 'liga a luz',
        ),
        ...(opts.replacesMessageId
          ? { replacesMessageId: opts.replacesMessageId }
          : {}),
      };
      const res = await http()
        .post(`${base(spaceId, conversationId)}/messages`)
        .set(bearer(user.token))
        .send(body);
      return { res, id, body };
    },
    /** The same, raw: resend a body (or a broken one). */
    sendRaw: (
      user: KeyedUser,
      spaceId: string,
      conversationId: string,
      body: object,
    ) =>
      http()
        .post(`${base(spaceId, conversationId)}/messages`)
        .set(bearer(user.token))
        .send(body),
    /** The executor hub sends a message (born acknowledged). */
    hubSend: async (
      hubToken: string,
      spaceId: string,
      conversationId: string,
      keys: ConversationKeys,
      opts: { id?: string; text?: string; keyVersion?: number } = {},
    ) => {
      const id = opts.id ?? newId();
      const keyVersion = opts.keyVersion ?? keys.length;
      const body = {
        id,
        keyVersion,
        encryptedBody: await messageBody(
          keys[keyVersion - 1]!,
          spaceId,
          conversationId,
          id,
          keyVersion,
          opts.text ?? 'feito',
        ),
      };
      const res = await http()
        .post(`/hub/conversations/${conversationId}/messages`)
        .set(bearer(hubToken))
        .send(body);
      return { res, id, body };
    },
    hubAck: (hubToken: string, conversationId: string, messageId: string) =>
      http()
        .post(`/hub/conversations/${conversationId}/messages/${messageId}/ack`)
        .set(bearer(hubToken)),
    deleteMessage: (
      user: KeyedUser,
      spaceId: string,
      conversationId: string,
      messageId: string,
    ) =>
      http()
        .delete(`${base(spaceId, conversationId)}/messages/${messageId}`)
        .set(bearer(user.token)),
    hubDeleteMessage: (
      hubToken: string,
      conversationId: string,
      messageId: string,
    ) =>
      http()
        .delete(`/hub/conversations/${conversationId}/messages/${messageId}`)
        .set(bearer(hubToken)),
    /** A person opens a conversation in the space (key v1 sealed for them and, optionally, for the executor hub). */
    create: async (
      user: KeyedUser,
      spaceId: string,
      opts: {
        executor?: HubRecipient | null;
        id?: string;
        state?: string;
        /** Move: the old conversation (in another space) this one replaces. */
        movedFrom?: { spaceId: string; conversationId: string };
      } = {},
    ) => {
      const id = opts.id ?? newId();
      const key = await newConversationKey();
      const res = await http()
        .post(base(spaceId))
        .set(bearer(user.token))
        .send({
          id,
          ...(opts.state ? { state: opts.state } : {}),
          ...(opts.movedFrom ? { movedFrom: opts.movedFrom } : {}),
          encryptedHeader: await header(key, spaceId, id),
          wrappedKey: await sealConversationKey(key, user.account.publicKey),
          ...(opts.executor
            ? {
                executor: {
                  hubId: opts.executor.hubId,
                  wrappedKey: await sealConversationKey(
                    key,
                    opts.executor.publicKey,
                  ),
                },
              }
            : {}),
        });
      return { res, id, keys: [key] as ConversationKeys };
    },
    /** The executor hub opens a conversation in the name of `owner`, sealing v1 for `participants` and itself. */
    hubCreate: async (
      hub: ClaimedHub,
      hubToken: string,
      spaceId: string,
      owner: Recipient,
      participants: Recipient[],
      opts: { id?: string; state?: string } = {},
    ) => {
      const id = opts.id ?? newId();
      const key = await newConversationKey();
      const res = await http()
        .post('/hub/conversations')
        .set(bearer(hubToken))
        .send({
          id,
          spaceId,
          ownerUserId: owner.userId,
          ...(opts.state ? { state: opts.state } : {}),
          encryptedHeader: await header(key, spaceId, id),
          grants: await Promise.all(
            participants.map(async (p) => ({
              userId: p.userId,
              wrappedKey: await sealConversationKey(key, p.publicKey),
            })),
          ),
          hubWrappedKey: await sealConversationKey(
            key,
            hub.identity.encryptionPublicKey,
          ),
        });
      return { res, id, keys: [key] as ConversationKeys };
    },
    get: (user: KeyedUser, spaceId: string, id: string) =>
      http().get(base(spaceId, id)).set(bearer(user.token)),
    hubGet: (hubToken: string, id: string) =>
      http().get(`/hub/conversations/${id}`).set(bearer(hubToken)),
    /** Seals every version for each target. */
    share: async (
      user: KeyedUser,
      spaceId: string,
      id: string,
      targets: Recipient[],
      keys: ConversationKeys,
      path: 'participants' | 'participants/space' = 'participants',
    ) =>
      http()
        .post(`${base(spaceId, id)}/${path}`)
        .set(bearer(user.token))
        .send({
          participants: await Promise.all(
            targets.map(async (t) => ({
              userId: t.userId,
              grants: await allVersions(keys, t.publicKey),
            })),
          ),
        }),
    /** Raw body variant (fake copies are fine: the backend only checks the format). */
    shareRaw: (
      user: KeyedUser,
      spaceId: string,
      id: string,
      body: unknown,
      path: 'participants' | 'participants/space' = 'participants',
    ) =>
      http()
        .post(`${base(spaceId, id)}/${path}`)
        .set(bearer(user.token))
        .send(body as object),
    leave: (user: KeyedUser, spaceId: string, id: string) =>
      http()
        .post(`${base(spaceId, id)}/leave`)
        .set(bearer(user.token)),
    remove: (user: KeyedUser, spaceId: string, id: string, userId: string) =>
      http()
        .delete(`${base(spaceId, id)}/participants/${userId}`)
        .set(bearer(user.token)),
    setState: (user: KeyedUser, spaceId: string, id: string, state: string) =>
      http()
        .put(`${base(spaceId, id)}/state`)
        .set(bearer(user.token))
        .send({ state }),
    hubSetState: (hubToken: string, id: string, state: string) =>
      http()
        .put(`/hub/conversations/${id}/state`)
        .set(bearer(hubToken))
        .send({ state }),
    /** New executor (null removes it): every version sealed for the new hub. */
    changeExecutor: async (
      user: KeyedUser,
      spaceId: string,
      id: string,
      hub: HubRecipient | null,
      keys: ConversationKeys,
    ) =>
      http()
        .put(`${base(spaceId, id)}/executor`)
        .set(bearer(user.token))
        .send(
          hub
            ? {
                hubId: hub.hubId,
                grants: await allVersions(keys, hub.publicKey),
              }
            : { hubId: null, grants: [] },
        ),
    /** Body of a rotation: the new version sealed for `recipients` and `hubs`. */
    rotationBody: async (
      version: number,
      key: Uint8Array,
      recipients: Recipient[],
      hubs: HubRecipient[],
    ) => ({
      version,
      grants: await Promise.all(
        recipients.map(async (r) => ({
          userId: r.userId,
          wrappedKey: await sealConversationKey(key, r.publicKey),
        })),
      ),
      hubGrants: await Promise.all(
        hubs.map(async (h) => ({
          hubId: h.hubId,
          wrappedKey: await sealConversationKey(key, h.publicKey),
        })),
      ),
    }),
    rotate: (user: KeyedUser, spaceId: string, id: string, body: object) =>
      http()
        .post(`${base(spaceId, id)}/keys`)
        .set(bearer(user.token))
        .send(body),
    hubRotate: (hubToken: string, id: string, body: object) =>
      http()
        .post(`/hub/conversations/${id}/keys`)
        .set(bearer(hubToken))
        .send(body),
    /** What a participant's app does with a copy from the API. */
    open: (user: KeyedUser, wrappedKey: string) =>
      openConversationKey(
        wrappedKey,
        user.account.publicKey,
        user.account.privateKey,
      ),
    hubOpens: (hub: ClaimedHub, wrappedKey: string) =>
      openConversationKey(
        wrappedKey,
        hub.identity.encryptionPublicKey,
        hub.identity.encryptionPrivateKey,
      ),
  };
}

export type ConversationsKit = ReturnType<typeof conversationsKit>;

/**
 * People made straight through the repositories (no Argon2 on the client), member of the organization and reader of
 * the space: for limits that need many people. Their key copies can be fake (the backend only checks the format).
 */
export async function bulkSpaceReaders(
  app: INestApplication,
  orgId: string,
  spaceId: string,
  count: number,
): Promise<string[]> {
  const users = app.get(UserRepository);
  const members = app.get(MembershipRepository);
  const orgRoles = app.get(RoleAssignmentRepository);
  const spaceRoles = app.get(SpaceRoleRepository);
  const uow = app.get(UnitOfWork);
  const b64 = (n: number, first?: number) => {
    const b = Buffer.alloc(n, 0xab);
    if (first !== undefined) b[0] = first;
    return b.toString('base64url');
  };
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const now = new Date();
    const user = User.register({
      name: `Bulk ${i}`,
      email: `bulk-${newId()}@example.com`,
      authHash: '$argon2id$v=19$m=19456,t=2,p=1$fake',
      kdfSalt: b64(16),
      kdfParams: { ...DEFAULT_KDF_PARAMS },
      publicKey: b64(32),
      encryptedPrivateKey: b64(73, 0x01),
      ...testRecoveryFields(),
      now,
    });
    await users.create(user);
    await uow.run(async () => {
      await members.add(orgId, user.id, now);
      await orgRoles.assignOrgRole(orgId, user.id, 'org_member', null);
      await spaceRoles.assign(orgId, spaceId, user.id, 'space_reader', null);
    });
    ids.push(user.id);
  }
  return ids;
}

/** A well-formed fake copy (`0x01 ‖ 80 bytes`). */
export const fakeWrappedKey = (fill = 0xcd) => {
  const b = Buffer.alloc(81, fill);
  b[0] = 0x01;
  return b.toString('base64url');
};

/** Raw conversation row (owner role, no RLS), tombstone included. */
export async function conversationRow(id: string) {
  const rows = await (
    await adminDataSource()
  ).query(
    `SELECT owner_user_id, executor_hub_id, state, current_key_version, key_rotation_required,
            participant_user_ids, deleted_at IS NOT NULL AS deleted
       FROM conversations WHERE id = $1`,
    [id],
  );
  return (
    (rows[0] as
      | {
          owner_user_id: string;
          executor_hub_id: string | null;
          state: string;
          current_key_version: number;
          key_rotation_required: boolean;
          participant_user_ids: string[];
          deleted: boolean;
        }
      | undefined) ?? null
  );
}

/** Live key copies of a conversation: `[keyVersion, userId | hubId]`, sorted. */
export async function liveGrants(id: string): Promise<[number, string][]> {
  const rows: { key_version: number; who: string }[] = await (
    await adminDataSource()
  ).query(
    `SELECT key_version, COALESCE(user_id, hub_id)::text AS who
       FROM conversation_key_grants
      WHERE conversation_id = $1 AND deleted_at IS NULL
      ORDER BY key_version, who`,
    [id],
  );
  return rows.map((r) => [r.key_version, r.who]);
}

/** Live participants of a conversation (user ids, sorted). */
export async function liveParticipants(id: string): Promise<string[]> {
  const rows: { user_id: string }[] = await (
    await adminDataSource()
  ).query(
    `SELECT user_id FROM conversation_participants
      WHERE conversation_id = $1 AND deleted_at IS NULL ORDER BY user_id`,
    [id],
  );
  return rows.map((r) => r.user_id);
}

/** Raw message rows of a conversation (owner role, no RLS), tombstones included, in send order. */
export async function messageRows(conversationId: string) {
  const rows = await (
    await adminDataSource()
  ).query(
    `SELECT id, author_user_id, author_hub_id, key_version, encrypted_body, body_bytes, replaces_message_id,
            pending, acked_at, sent_at, deleted_at IS NOT NULL AS deleted
       FROM conversation_messages WHERE conversation_id = $1 ORDER BY sent_at, id`,
    [conversationId],
  );
  return rows as {
    id: string;
    author_user_id: string | null;
    author_hub_id: string | null;
    key_version: number;
    encrypted_body: string | null;
    body_bytes: number;
    replaces_message_id: string | null;
    pending: boolean;
    acked_at: Date | null;
    sent_at: Date;
    deleted: boolean;
  }[];
}

/** The conversations part of a space usage (the counter kept by trigger): `{ bodyBytes, trashBytes }`. */
export async function conversationSpaceUsage(spaceId: string) {
  const rows: { body_bytes: string; trash_bytes: string }[] = await (
    await adminDataSource()
  ).query(
    `SELECT body_bytes::text, trash_bytes::text FROM conversation_space_usage WHERE space_id = $1`,
    [spaceId],
  );
  return {
    bodyBytes: Number(rows[0]?.body_bytes ?? 0),
    trashBytes: Number(rows[0]?.trash_bytes ?? 0),
  };
}

/** `last_message_at` of a conversation (owner role). */
export async function lastMessageAt(conversationId: string) {
  const rows: { last_message_at: Date | null }[] = await (
    await adminDataSource()
  ).query(`SELECT last_message_at FROM conversations WHERE id = $1`, [
    conversationId,
  ]);
  return rows[0]?.last_message_at ?? null;
}
