import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { UserDirectory } from '../../src/identity/application/user-directory.js';
import { OrganizationAdministration } from '../../src/organizations/application/organization-administration.js';
import type { AuditActor } from '../../src/shared/application/audit-actor.js';
import { newId } from '../../src/shared/domain/id.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import { identityClient, type KeyedUser } from '../support/identity-client.js';
import { auditRows } from '../support/spaces-db.js';

// Operação administrativa do `organizations` (plano platform-roles, Task 3): nomear admin sem exigir um admin, com
// a origem da auditoria vinda de quem chama. Pelo app Nest (papel de runtime, RLS valendo).
describe('OrganizationAdministration (e2e)', () => {
  let app: INestApplication;
  let admin: DataSource;
  const c = identityClient(() => app);
  const s = c.spaces;
  const orgAdmin = () => app.get(OrganizationAdministration);
  const platform = (): AuditActor & { kind: 'platform' } => ({
    kind: 'platform',
    supportRequestId: newId(),
  });

  let olivia: KeyedUser; // admin original da organização
  let bia: KeyedUser; // membro
  let carl: KeyedUser; // conta cadastrada, fora da organização
  let orgId: string;

  const orgRole = async (userId: string): Promise<string | null> => {
    const rows: { key: string }[] = await admin.query(
      `SELECT r.key FROM role_assignments ra JOIN roles r ON r.id = ra.role_id
        WHERE ra.organization_id = $1 AND ra.user_id = $2 AND ra.scope_type = 'organization'
          AND ra.deleted_at IS NULL`,
      [orgId, userId],
    );
    return rows[0]?.key ?? null;
  };

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
    admin = await adminDataSource();
    olivia = await s.signUpKeyed('oa-olivia@example.com', 'Olivia');
    bia = await s.signUpKeyed('oa-bia@example.com', 'Bia');
    carl = await s.signUpKeyed('oa-carl@example.com', 'Carl');
    ({ orgId } = await s.orgWithKit(olivia, 'Appoint Org'));
    await s.joinOrg(olivia, orgId, bia);
  }, 120_000);
  afterAll(async () => {
    await app.close();
  });

  it('a current member becomes org_admin, member.role_changed by the platform (no user id)', async () => {
    const actor = platform();
    await expect(
      orgAdmin().appointAdmin(orgId, bia.userId, actor, new Date()),
    ).resolves.toEqual({ joined: false });
    expect(await orgRole(bia.userId)).toBe('org_admin');
    const changed = await auditRows(orgId, 'member.role_changed');
    expect(changed).toEqual([
      {
        action: 'member.role_changed',
        user_id: null,
        metadata: {
          targetUserId: bia.userId,
          from: 'org_member',
          to: 'org_admin',
          actor: 'platform',
          supportRequestId: actor.supportRequestId,
        },
      },
    ]);

    // repetir: já é admin, nenhuma linha nova
    const auditBefore = await auditRows(orgId, '');
    await expect(
      orgAdmin().appointAdmin(orgId, bia.userId, platform(), new Date()),
    ).resolves.toEqual({ joined: false });
    expect(await auditRows(orgId, '')).toEqual(auditBefore);
  });

  it('a registered non-member joins as org_admin: member.joined, then member.role_changed', async () => {
    const actor = platform();
    const joinedBefore = (await auditRows(orgId, 'member.joined')).length;
    await expect(
      orgAdmin().appointAdmin(orgId, carl.userId, actor, new Date()),
    ).resolves.toEqual({ joined: true });
    expect(await orgRole(carl.userId)).toBe('org_admin');
    const origin = {
      actor: 'platform',
      supportRequestId: actor.supportRequestId,
    };
    const joined = await auditRows(orgId, 'member.joined');
    expect(joined).toHaveLength(joinedBefore + 1);
    expect(joined.at(-1)).toEqual({
      action: 'member.joined',
      user_id: null,
      metadata: { targetUserId: carl.userId, roleKey: 'org_admin', ...origin },
    });
    expect((await auditRows(orgId, 'member.role_changed')).at(-1)).toEqual({
      action: 'member.role_changed',
      user_id: null,
      metadata: {
        targetUserId: carl.userId,
        from: null,
        to: 'org_admin',
        ...origin,
      },
    });
    // a pessoa nomeada usa a organização como qualquer admin
    await c
      .http()
      .get(`/organizations/${orgId}/members`)
      .set(c.bearer(carl.token))
      .expect(200);

    await expect(orgAdmin().summary(orgId)).resolves.toEqual({
      organizationId: orgId,
      name: 'Appoint Org',
      personal: false,
      adminUserIds: [olivia.userId, bia.userId, carl.userId].sort(),
      memberCount: 3,
    });
  });

  it('a personal organization: 422 personal-organization-protected, nothing written', async () => {
    const personal: { id: string }[] = await admin.query(
      `SELECT id FROM organizations WHERE personal_owner_user_id = $1`,
      [olivia.userId],
    );
    await expect(
      orgAdmin().appointAdmin(
        personal[0]!.id,
        bia.userId,
        platform(),
        new Date(),
      ),
    ).rejects.toMatchObject({ code: 'personal-organization-protected' });
    expect(await auditRows(personal[0]!.id, 'member.')).toEqual([]);
    await expect(orgAdmin().summary(personal[0]!.id)).resolves.toMatchObject({
      personal: true,
      adminUserIds: [olivia.userId],
      memberCount: 1,
    });
  });

  it('unknown organization or user: 404; summary null for an unknown organization', async () => {
    await expect(
      orgAdmin().appointAdmin(newId(), bia.userId, platform(), new Date()),
    ).rejects.toMatchObject({ code: 'organization-not-found' });
    await expect(
      orgAdmin().appointAdmin(orgId, newId(), platform(), new Date()),
    ).rejects.toMatchObject({ code: 'user-not-found' });
    await expect(orgAdmin().summary(newId())).resolves.toBeNull();
  });

  it('UserDirectory.findPublicByEmail finds a registered account like the login does', async () => {
    await expect(
      app.get(UserDirectory).findPublicByEmail('  OA-Carl@Example.com '),
    ).resolves.toMatchObject({ id: carl.userId, email: 'oa-carl@example.com' });
    await expect(
      app.get(UserDirectory).findPublicByEmail('nobody@example.com'),
    ).resolves.toBeNull();
  });
});
