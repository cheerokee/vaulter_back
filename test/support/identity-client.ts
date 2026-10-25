import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  type ClientAccount,
  createClientAccount,
  generateSpaceKey,
  openSpaceKey,
  recoveryKitKeypair,
  sealSpaceKey,
} from './client-crypto.js';

/** A signed-up user with their own key pair (needed to seal and open space keys). */
export type KeyedUser = {
  userId: string;
  token: string;
  email: string;
  account: ClientAccount;
};

/** Who receives a sealed copy: the user id and the X25519 public key. */
export type Recipient = { userId: string; publicKey: string };

export const recipientOf = (u: KeyedUser): Recipient => ({
  userId: u.userId,
  publicKey: u.account.publicKey,
});

export const DEFAULT_DEVICE = { name: 'Pixel 9', platform: 'android' };

/** HTTP helpers for the auth endpoints, shared by the identity e2e specs. */
export function identityClient(getApp: () => INestApplication) {
  const http = () => request(getApp().getHttpServer());

  const registerBody = (
    account: ClientAccount,
    email: string,
    over: Record<string, unknown> = {},
  ) => ({
    name: 'Ana',
    email,
    authProof: account.authProof,
    kdfSalt: account.kdfSalt,
    kdfParams: account.kdfParams,
    publicKey: account.publicKey,
    encryptedPrivateKey: account.encryptedPrivateKey,
    device: DEFAULT_DEVICE,
    ...over,
  });

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /**
   * Space helpers with the REAL client-side crypto: the space key is generated here, sealed for each
   * recipient (and for the organization recovery kit) and opened with the recipient's private key.
   * The backend only ever sees sealed copies. `keys[i]` is the key of version i + 1.
   */
  const setRecoveryKit = (
    owner: KeyedUser,
    orgId: string,
    kitPublicKey: string,
  ) =>
    http()
      .put(`/organizations/${orgId}/recovery-key`)
      .set(auth(owner.token))
      .send({
        recoveryPublicKey: kitPublicKey,
        currentAuthProof: owner.account.authProof,
      });

  const spaces = {
    signUpKeyed: async (
      email: string,
      name = 'Ana',
      password = 'correct horse battery staple',
    ): Promise<KeyedUser> => {
      const account = await createClientAccount(password);
      const res = await http()
        .post('/auth/register')
        .send(registerBody(account, email, { name }))
        .expect(201);
      return {
        userId: res.body.user.id as string,
        token: res.body.session.accessToken as string,
        email,
        account,
      };
    },
    setRecoveryKit,
    /** New organization owned by `owner`, with a fresh recovery kit registered. */
    orgWithKit: async (owner: KeyedUser, name = 'Acme') => {
      const res = await http()
        .post('/organizations')
        .set(auth(owner.token))
        .send({ name })
        .expect(201);
      const orgId = res.body.id as string;
      const kit = await recoveryKitKeypair();
      await setRecoveryKit(owner, orgId, kit.publicKey).expect(204);
      return { orgId, kit };
    },
    /** Invites `user` into the organization and accepts it. */
    joinOrg: async (
      admin: KeyedUser,
      orgId: string,
      user: KeyedUser,
      roleKey: 'org_admin' | 'org_member' = 'org_member',
    ) => {
      const inv = await http()
        .post(`/organizations/${orgId}/invitations`)
        .set(auth(admin.token))
        .send({ roleKey })
        .expect(201);
      await http()
        .post('/invitations/accept')
        .set(auth(user.token))
        .send({ token: inv.body.token as string })
        .expect(200);
    },
    /** Generates the space key v1 and seals it for the creator and the kit. */
    create: async (
      creator: KeyedUser,
      orgId: string,
      kitPublicKey: string,
      name = 'Manuais',
    ) => {
      const key = await generateSpaceKey();
      const res = await http()
        .post(`/organizations/${orgId}/spaces`)
        .set(auth(creator.token))
        .send({
          name,
          wrappedKey: await sealSpaceKey(key, creator.account.publicKey),
          recoveryPublicKey: kitPublicKey,
          recoveryWrappedKey: await sealSpaceKey(key, kitPublicKey),
        });
      return { res, key, spaceId: res.body?.id as string };
    },
    /** Seals every given version (keys[i] = version i + 1) for the target. */
    addMember: async (
      token: string,
      spaceId: string,
      target: Recipient,
      keys: Uint8Array[],
      roleKey = 'space_editor',
    ) =>
      http()
        .post(`/spaces/${spaceId}/members`)
        .set(auth(token))
        .send({
          userId: target.userId,
          roleKey,
          grants: await Promise.all(
            keys.map(async (key, i) => ({
              version: i + 1,
              wrappedKey: await sealSpaceKey(key, target.publicKey),
            })),
          ),
        }),
    members: (token: string, spaceId: string) =>
      http().get(`/spaces/${spaceId}/members`).set(auth(token)),
    /** Members as recipients, read from the API like the app does (publicKey comes with each member). */
    memberRecipients: async (
      token: string,
      spaceId: string,
    ): Promise<Recipient[]> => {
      const res = await http()
        .get(`/spaces/${spaceId}/members?limit=100`)
        .set(auth(token))
        .expect(200);
      return (res.body.items as Recipient[]).map((m) => ({
        userId: m.userId,
        publicKey: m.publicKey,
      }));
    },
    /** New key version sealed for exactly `recipients` and for the kit. */
    rotate: async (
      token: string,
      spaceId: string,
      input: {
        version: number;
        key: Uint8Array;
        recipients: Recipient[];
        kitPublicKey: string;
      },
    ) =>
      http()
        .post(`/spaces/${spaceId}/keys`)
        .set(auth(token))
        .send({
          version: input.version,
          recoveryPublicKey: input.kitPublicKey,
          recoveryWrappedKey: await sealSpaceKey(input.key, input.kitPublicKey),
          grants: await Promise.all(
            input.recipients.map(async (r) => ({
              userId: r.userId,
              wrappedKey: await sealSpaceKey(input.key, r.publicKey),
            })),
          ),
        }),
    /** Re-seals the given versions (keys[i] = version i + 1) for the kit. */
    rewrapRecovery: async (
      token: string,
      spaceId: string,
      kitPublicKey: string,
      keys: Uint8Array[],
      versions: number[] = keys.map((_, i) => i + 1),
    ) =>
      http()
        .put(`/spaces/${spaceId}/keys/recovery`)
        .set(auth(token))
        .send({
          recoveryPublicKey: kitPublicKey,
          versions: await Promise.all(
            versions.map(async (version) => ({
              version,
              wrappedKey: await sealSpaceKey(keys[version - 1]!, kitPublicKey),
            })),
          ),
        }),
    /** POST /spaces/:id/recover/copies (org admin, orphan space, reauthenticated): the kit copies. */
    recoveryCopies: (
      token: string,
      spaceId: string,
      currentAuthProof: string,
    ) =>
      http()
        .post(`/spaces/${spaceId}/recover/copies`)
        .set(auth(token))
        .send({ currentAuthProof }),
    /**
     * What the admin's app does to reopen an orphan space: reads the kit copies through the API (reauthenticated)
     * and opens each with the kit secret. Returns the keys in version order (keys[i] = version i + 1).
     */
    openRecoveryCopies: async (
      admin: KeyedUser,
      spaceId: string,
      kit: { publicKey: string; privateKey: Uint8Array },
    ) => {
      const res = await http()
        .post(`/spaces/${spaceId}/recover/copies`)
        .set(auth(admin.token))
        .send({ currentAuthProof: admin.account.authProof })
        .expect(200);
      const copies = res.body.copies as {
        version: number;
        recoveryWrappedKey: string;
      }[];
      return Promise.all(
        copies.map((c) =>
          openSpaceKey(c.recoveryWrappedKey, kit.publicKey, kit.privateKey),
        ),
      );
    },
    /** GET /spaces/:id/keys and opens every copy with the user's private key (throws if any does not open). */
    openKeys: async (user: KeyedUser, spaceId: string) => {
      const res = await http()
        .get(`/spaces/${spaceId}/keys`)
        .set(auth(user.token))
        .expect(200);
      const keys = new Map<number, Uint8Array>();
      for (const k of res.body.keys as {
        version: number;
        wrappedKey: string;
      }[]) {
        keys.set(
          k.version,
          await openSpaceKey(
            k.wrappedKey,
            user.account.publicKey,
            user.account.privateKey,
          ),
        );
      }
      return { currentVersion: res.body.currentVersion as number, keys };
    },
  };

  return {
    http,
    spaces,
    registerBody,
    register: (
      account: ClientAccount,
      email: string,
      over: Record<string, unknown> = {},
    ) =>
      http()
        .post('/auth/register')
        .send(registerBody(account, email, over)),
    login: (
      email: string,
      authProof: string,
      device: { name: string; platform: string } = DEFAULT_DEVICE,
    ) => http().post('/auth/login').send({ email, authProof, device }),
    bearer: (token: string) => ({ Authorization: `Bearer ${token}` }),
    /** Registers a user and returns what the org specs need. */
    signUp: async (account: ClientAccount, email: string, name = 'Ana') => {
      const res = await http()
        .post('/auth/register')
        .send(registerBody(account, email, { name }))
        .expect(201);
      return {
        userId: res.body.user.id as string,
        token: res.body.session.accessToken as string,
        email,
      };
    },
    createOrg: (token: string, name = 'Acme') =>
      http()
        .post('/organizations')
        .set({ Authorization: `Bearer ${token}` })
        .send({ name }),
    invite: (
      token: string,
      orgId: string,
      roleKey: 'org_admin' | 'org_member' = 'org_member',
      email?: string,
    ) =>
      http()
        .post(`/organizations/${orgId}/invitations`)
        .set({ Authorization: `Bearer ${token}` })
        .send(email ? { roleKey, email } : { roleKey }),
    acceptInvite: (token: string, inviteToken: string) =>
      http()
        .post('/invitations/accept')
        .set({ Authorization: `Bearer ${token}` })
        .send({ token: inviteToken }),
  };
}

/** For the async space helpers (they seal before sending): asserts the status and returns the response. */
export async function expectStatus(
  pending: Promise<request.Response>,
  status: number,
): Promise<request.Response> {
  const res = await pending;
  if (res.status !== status) {
    throw new Error(
      `expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }
  return res;
}
