import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { AuthenticateHubTokenUseCase } from '../../src/hubs/application/authenticate-hub-token.use-case.js';
import { HubAdministration } from '../../src/hubs/application/hub-administration.js';
import { HubTokenService } from '../../src/identity/application/hub-token-service.js';
import type { AuditActor } from '../../src/shared/application/audit-actor.js';
import { NotFoundError } from '../../src/shared/domain/errors.js';
import { newId } from '../../src/shared/domain/id.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import {
  hubDeregistered,
  hubSpaceRows,
  hubsKit,
  linkRow,
  liveHubRoles,
} from '../support/hubs-kit.js';
import { identityClient, type KeyedUser } from '../support/identity-client.js';
import { auditRows, hubRoom, spaceRow } from '../support/spaces-db.js';

const HUB_404 = { constructor: NotFoundError, code: 'hub-not-found' };

// Operação administrativa do `hubs` (plano platform-roles, Task 3): o desregistro sem exigir o dono, com a origem
// da auditoria vinda de quem chama. Pelo app Nest (papel de runtime, RLS valendo), com a cripto real.
describe('HubAdministration (e2e)', () => {
  let app: INestApplication;
  let admin: DataSource;
  const c = identityClient(() => app);
  const s = c.spaces;
  const k = hubsKit(() => app);
  const hubAdmin = () => app.get(HubAdministration);

  let olivia: KeyedUser; // dona do Hub
  let bia: KeyedUser;

  const org = async (
    creator: KeyedUser,
    name: string,
    members: KeyedUser[],
  ) => {
    const { orgId, kit } = await s.orgWithKit(creator, name);
    for (const u of members) await s.joinOrg(creator, orgId, u);
    return { orgId, kit };
  };
  const space = async (creator: KeyedUser, orgId: string, kitPk: string) => {
    const sp = await s.create(creator, orgId, kitPk, `S-${newId()}`);
    expect(sp.res.status).toBe(201);
    return { spaceId: sp.spaceId, keys: [sp.key] };
  };
  const auditIds = async (): Promise<Set<string>> =>
    new Set(
      (
        (await admin.query(`SELECT id FROM audit_logs`)) as { id: string }[]
      ).map((r) => r.id),
    );

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
    admin = await adminDataSource();
    olivia = await s.signUpKeyed('ha-olivia@example.com', 'Olivia');
    bia = await s.signUpKeyed('ha-bia@example.com', 'Bia');
  }, 120_000);
  afterAll(async () => {
    await app.close();
  });

  it('deregister by the platform: the same state as the owner deregistration, every new audit row attributed to the platform', async () => {
    const hub = await k.claim(olivia);
    const a = await org(olivia, 'Adm A', [bia]);
    const b = await org(olivia, 'Adm B', []);
    await k.link(olivia, hub.hubId, a.orgId);
    await k.link(olivia, hub.hubId, b.orgId);
    const sa = await space(olivia, a.orgId, a.kit.publicKey);
    const sb = await space(olivia, b.orgId, b.kit.publicKey);
    for (const sp of [sa, sb]) await k.addSpace(olivia, hub.hubId, sp.spaceId);
    await k.grantRoom(olivia, hub, sa.spaceId, a.kit.publicKey, sa.keys);
    await k.grantRoom(olivia, hub, sb.spaceId, b.kit.publicKey, sb.keys);
    await k.assignRole(olivia, hub.hubId, bia.userId, 'hub_user');
    // estado legado: o vínculo de B revogado por fora, com a Sala ainda lá
    await admin.query(
      `UPDATE hub_organization SET status = 'revoked' WHERE hub_id = $1 AND organization_id = $2`,
      [hub.hubId, b.orgId],
    );
    const token = await app.get(HubTokenService).issue(hub.hubId);
    const personal: { id: string }[] = await admin.query(
      `SELECT id FROM organizations WHERE personal_owner_user_id = $1`,
      [olivia.userId],
    );
    const personalId = personal[0]!.id;

    await expect(hubAdmin().summary(hub.hubId)).resolves.toEqual({
      hubId: hub.hubId,
      name: 'Sala',
      ownerUserId: olivia.userId,
      deregistered: false,
      organizationIds: [personalId, a.orgId].sort(),
    });

    const before = await auditIds();
    const actor: AuditActor = { kind: 'platform', supportRequestId: newId() };
    await hubAdmin().deregister(hub.hubId, actor);

    expect(await hubDeregistered(hub.hubId)).toBe(true);
    for (const o of [a, b]) {
      expect((await linkRow(hub.hubId, o.orgId))?.deleted).toBe(true);
    }
    expect((await linkRow(hub.hubId, a.orgId))?.status).toBe('revoked');
    expect((await hubSpaceRows(hub.hubId)).map(([, live]) => live)).toEqual([
      false,
      false,
    ]);
    for (const sp of [sa, sb]) {
      expect(await hubRoom(sp.spaceId, hub.hubId)).toEqual({
        roleKey: null,
        versions: [],
        tombstoned: 1,
      });
      expect((await spaceRow(sp.spaceId)).key_rotation_required).toBe(true);
    }
    expect(await liveHubRoles(hub.hubId)).toEqual([]);
    expect(await k.access(olivia, hub.hubId)).toBeNull();
    await expect(
      app.get(AuthenticateHubTokenUseCase).execute(token.token),
    ).rejects.toMatchObject({ code: 'invalid-hub-token' });

    // auditoria: o mesmo conteúdo do desregistro pelo dono, mais a origem; nenhuma linha com a conta de alguém
    const newRows: {
      organization_id: string;
      action: string;
      user_id: string | null;
      metadata: Record<string, unknown>;
    }[] = (
      await admin.query(
        `SELECT id, organization_id, action, user_id, metadata FROM audit_logs ORDER BY created_at, id`,
      )
    ).filter((r: { id: string }) => !before.has(r.id));
    const origin = {
      actor: 'platform',
      supportRequestId: actor.supportRequestId,
    };
    expect(newRows.map((r) => r.action).sort()).toEqual(
      [
        'hub.deregistered',
        'hub.organization.revoked', // A
        'hub.organization.revoked', // pessoal
        'hub.room.revoked', // A
        'hub.room.revoked', // B
      ].sort(),
    );
    for (const r of newRows) {
      expect(r.user_id).toBeNull();
      expect(r.metadata).toMatchObject(origin);
    }
    expect(
      (await auditRows(a.orgId, 'hub.organization.revoked'))[0]!.metadata,
    ).toEqual({
      hubId: hub.hubId,
      reason: 'hub_deregistered',
      spaceIds: [sa.spaceId],
      ...origin,
    });
    expect(await auditRows(b.orgId, 'hub.organization.revoked')).toEqual([]);
    expect((await auditRows(b.orgId, 'hub.room.revoked'))[0]!.metadata).toEqual(
      {
        spaceId: sb.spaceId,
        hubId: hub.hubId,
        reason: 'hub_deregistered',
        ...origin,
      },
    );
    const dereg = (await auditRows(personalId, 'hub.deregistered')).filter(
      (r) => r.metadata['hubId'] === hub.hubId,
    );
    expect(dereg).toHaveLength(1);
    expect(dereg[0]!.metadata).toEqual({
      hubId: hub.hubId,
      organizationIds: [personalId, a.orgId].sort(),
      roomSpaceIds: [sa.spaceId, sb.spaceId].sort(),
      ...origin,
    });

    await expect(hubAdmin().summary(hub.hubId)).resolves.toEqual({
      hubId: hub.hubId,
      name: 'Sala',
      ownerUserId: olivia.userId,
      deregistered: true,
      organizationIds: [],
    });
  });

  it('an already deregistered, unknown or malformed hub: hub-not-found, nothing audited; summary null for unknown', async () => {
    const hub = await k.claim(olivia);
    await k.deregister(olivia, hub.hubId);
    const before = await auditIds();
    const actor: AuditActor = { kind: 'platform', supportRequestId: newId() };
    for (const id of [hub.hubId, newId(), 'not-a-uuid']) {
      await expect(hubAdmin().deregister(id, actor)).rejects.toMatchObject(
        HUB_404,
      );
    }
    expect(await auditIds()).toEqual(before);
    await expect(hubAdmin().summary(newId())).resolves.toBeNull();
    await expect(hubAdmin().summary('not-a-uuid')).resolves.toBeNull();
  });

  it('a user actor keeps the owner-path audit (user id, no origin metadata)', async () => {
    const hub = await k.claim(olivia);
    const x = await org(olivia, 'Adm User', []);
    await k.link(olivia, hub.hubId, x.orgId);
    await hubAdmin().deregister(hub.hubId, {
      kind: 'user',
      userId: olivia.userId,
    });
    const rows = await auditRows(x.orgId, 'hub.organization.revoked');
    expect(rows).toEqual([
      {
        action: 'hub.organization.revoked',
        user_id: olivia.userId,
        metadata: {
          hubId: hub.hubId,
          reason: 'hub_deregistered',
          spaceIds: [],
        },
      },
    ]);
  });
});
