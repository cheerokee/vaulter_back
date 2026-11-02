import type { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AddHubSpaceUseCase } from '../../src/hubs/application/add-hub-space.use-case.js';
import { ApproveHubLinkUseCase } from '../../src/hubs/application/approve-hub-link.use-case.js';
import { AssignHubRoleUseCase } from '../../src/hubs/application/assign-hub-role.use-case.js';
import { ClaimHubUseCase } from '../../src/hubs/application/claim-hub.use-case.js';
import { DeregisterHubUseCase } from '../../src/hubs/application/deregister-hub.use-case.js';
import { EnrollHubUseCase } from '../../src/hubs/application/enroll-hub.use-case.js';
import { GrantRoomUseCase } from '../../src/hubs/application/grant-room.use-case.js';
import { HubAccess } from '../../src/hubs/application/hub-access.js';
import { IssueLinkCodeUseCase } from '../../src/hubs/application/issue-link-code.use-case.js';
import { LinkHubOrganizationUseCase } from '../../src/hubs/application/link-hub-organization.use-case.js';
import { RejectHubLinkUseCase } from '../../src/hubs/application/reject-hub-link.use-case.js';
import { RemoveHubRoleUseCase } from '../../src/hubs/application/remove-hub-role.use-case.js';
import { RemoveHubSpaceUseCase } from '../../src/hubs/application/remove-hub-space.use-case.js';
import { RequestHubLinkUseCase } from '../../src/hubs/application/request-hub-link.use-case.js';
import { RevokeRoomUseCase } from '../../src/hubs/application/revoke-room.use-case.js';
import { UnlinkHubOrganizationUseCase } from '../../src/hubs/application/unlink-hub-organization.use-case.js';
import { newId } from '../../src/shared/domain/id.js';
import { adminDataSource } from '../setup/test-app.js';
import { openSpaceKey, sealSpaceKey } from './client-crypto.js';
import {
  createHubIdentity,
  signEnrollment,
  type HubIdentity,
} from './hub-crypto.js';

type Who = { userId: string };
/** A claimed hub: its id and the device identity (the private keys never leave the "device"). */
export type ClaimedHub = { hubId: string; identity: HubIdentity };

/**
 * Hub use cases called through the Nest app, with the REAL hub crypto (enrollment signature, copies sealed for the
 * hub's X25519 key and opened with its private key). Shared by the hubs e2e specs (and by Task 9's HTTP specs as
 * a fixture: claim a hub, get a link code).
 */
export function hubsKit(getApp: () => INestApplication) {
  const app = () => getApp();
  const actor = (u: Who) => ({ userId: u.userId, sessionId: newId() });

  /** Enrolls a fresh device identity and claims it for `owner`. */
  const claim = async (owner: Who, name = 'Sala'): Promise<ClaimedHub> => {
    const identity = await createHubIdentity();
    const nonce = randomBytes(16).toString('base64url');
    const timestamp = new Date().toISOString();
    const { claimCode } = await app()
      .get(EnrollHubUseCase)
      .execute({
        signingPublicKey: identity.signingPublicKey,
        encryptionPublicKey: identity.encryptionPublicKey,
        nonce,
        timestamp,
        signature: await signEnrollment(identity, { nonce, timestamp }),
      });
    const view = await app()
      .get(ClaimHubUseCase)
      .execute(actor(owner), { claimCode, name });
    return { hubId: view.id, identity };
  };

  const ids = (hubId: string, organizationId: string) => ({
    hubId,
    organizationId,
  });

  return {
    actor,
    claim,
    access: (u: Who, hubId: string) =>
      app().get(HubAccess).find(hubId, u.userId),
    linkCode: (hubId: string) => app().get(IssueLinkCodeUseCase).execute(hubId),
    link: (owner: Who, hubId: string, orgId: string) =>
      app()
        .get(LinkHubOrganizationUseCase)
        .execute(actor(owner), ids(hubId, orgId)),
    request: (u: Who, linkCode: string, organizationId: string) =>
      app()
        .get(RequestHubLinkUseCase)
        .execute(actor(u), { linkCode, organizationId }),
    approve: (u: Who, hubId: string, orgId: string) =>
      app().get(ApproveHubLinkUseCase).execute(actor(u), ids(hubId, orgId)),
    reject: (u: Who, hubId: string, orgId: string) =>
      app().get(RejectHubLinkUseCase).execute(actor(u), ids(hubId, orgId)),
    unlink: (u: Who, hubId: string, orgId: string) =>
      app()
        .get(UnlinkHubOrganizationUseCase)
        .execute(actor(u), ids(hubId, orgId)),
    addSpace: (u: Who, hubId: string, spaceId: string) =>
      app().get(AddHubSpaceUseCase).execute(actor(u), { hubId, spaceId }),
    removeSpace: (u: Who, hubId: string, spaceId: string) =>
      app().get(RemoveHubSpaceUseCase).execute(actor(u), { hubId, spaceId }),
    /** Seals every version (keys[i] = version i + 1) for the hub's encryption key, like the owner's app. */
    grantRoom: async (
      u: Who,
      hub: ClaimedHub,
      spaceId: string,
      kitPublicKey: string,
      keys: Uint8Array[],
      roleKey?: string,
    ) =>
      app()
        .get(GrantRoomUseCase)
        .execute(actor(u), {
          hubId: hub.hubId,
          spaceId,
          ...(roleKey ? { roleKey } : {}),
          recoveryPublicKey: kitPublicKey,
          grants: await Promise.all(
            keys.map(async (key, i) => ({
              version: i + 1,
              wrappedKey: await sealSpaceKey(
                key,
                hub.identity.encryptionPublicKey,
              ),
            })),
          ),
        }),
    revokeRoom: (u: Who, hubId: string, spaceId: string) =>
      app().get(RevokeRoomUseCase).execute(actor(u), { hubId, spaceId }),
    assignRole: (u: Who, hubId: string, userId: string, roleKey: string) =>
      app()
        .get(AssignHubRoleUseCase)
        .execute(actor(u), { hubId, userId, roleKey }),
    removeRole: (u: Who, hubId: string, userId: string) =>
      app().get(RemoveHubRoleUseCase).execute(actor(u), { hubId, userId }),
    deregister: (u: Who, hubId: string) =>
      app().get(DeregisterHubUseCase).execute(actor(u), hubId),
    /** What the device does with a copy sealed for it. */
    hubOpens: (hub: ClaimedHub, wrappedKey: string) =>
      openSpaceKey(
        wrappedKey,
        hub.identity.encryptionPublicKey,
        hub.identity.encryptionPrivateKey,
      ),
  };
}

export type HubsKit = ReturnType<typeof hubsKit>;

/** Raw state of a hub link (owner role, no RLS), tombstones included; null when there is no row. */
export async function linkRow(
  hubId: string,
  organizationId: string,
): Promise<{
  status: string;
  deleted: boolean;
  owner_approved_by_user_id: string | null;
  org_approved_by_user_id: string | null;
} | null> {
  const rows = await (
    await adminDataSource()
  ).query(
    `SELECT status, deleted_at IS NOT NULL AS deleted, owner_approved_by_user_id, org_approved_by_user_id
       FROM hub_organization WHERE hub_id = $1 AND organization_id = $2`,
    [hubId, organizationId],
  );
  return rows[0] ?? null;
}

/** hub_space rows of a hub: `[spaceId, live]`, ordered by space. */
export async function hubSpaceRows(
  hubId: string,
): Promise<[spaceId: string, live: boolean][]> {
  const rows: { space_id: string; live: boolean }[] = await (
    await adminDataSource()
  ).query(
    `SELECT space_id, deleted_at IS NULL AS live FROM hub_space WHERE hub_id = $1 ORDER BY space_id`,
    [hubId],
  );
  return rows.map((r) => [r.space_id, r.live]);
}

/** Live hub-scope role rows of a hub: `[roleKey, userId | 'room']`, sorted. */
export async function liveHubRoles(hubId: string): Promise<string[][]> {
  const rows: { key: string; who: string }[] = await (
    await adminDataSource()
  ).query(
    `SELECT r.key, COALESCE(ra.user_id::text, 'room') AS who
       FROM role_assignments ra JOIN roles r ON r.id = ra.role_id
      WHERE ra.scope_type = 'hub' AND ra.hub_id = $1 AND ra.deleted_at IS NULL
      ORDER BY r.key, who`,
    [hubId],
  );
  return rows.map((r) => [r.key, r.who]);
}

export async function hubDeregistered(hubId: string): Promise<boolean> {
  const rows: { d: boolean }[] = await (
    await adminDataSource()
  ).query(`SELECT deleted_at IS NOT NULL AS d FROM hubs WHERE id = $1`, [
    hubId,
  ]);
  return rows[0]!.d;
}
