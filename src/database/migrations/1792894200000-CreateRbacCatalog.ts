import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  addSyncVersionTrigger,
  dropSyncVersionTrigger,
} from '../../shared/infra/db/migration-helpers.js';

// Dados congelados desta migration (ids UUID v7 fixos). Nada é exportado além da classe (o TypeORM trata todo export como
// migration); mudança no catálogo = nova migration, nunca edição aqui.
interface Queryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

const CATALOG_PERMISSIONS = {
  'memory.read': [
    '01a1714d-1b68-737c-86eb-ed4d28e45b48',
    'space',
    'Ver memórias',
    'Pode ler as memórias do espaço.',
  ],
  'memory.write': [
    '01a1714d-1b6b-764a-aeec-7884c38982be',
    'space',
    'Criar e editar memórias',
    'Pode adicionar e alterar memórias do espaço.',
  ],
  'memory.delete': [
    '01a1714d-1b6b-764a-aeec-7dce052bb802',
    'space',
    'Apagar memórias',
    'Pode apagar memórias do espaço.',
  ],
  'space.members.manage': [
    '01a1714d-1b6b-764a-aeec-827ddd92df5e',
    'space',
    'Gerenciar membros do espaço',
    'Pode convidar, remover e mudar o papel de quem participa do espaço.',
  ],
  'chat.voice': [
    '01a1714d-1b6b-764a-aeec-859563362f72',
    'hub',
    'Conversar por voz',
    'Pode falar com o Hub por voz.',
  ],
  'chat.live': [
    '01a1714d-1b6b-764a-aeec-8a9485c81156',
    'hub',
    'Conversar ao vivo',
    'Pode conversar com o Hub em tempo real.',
  ],
  'camera.view': [
    '01a1714d-1b6b-764a-aeec-8e2c58e6029f',
    'hub',
    'Ver imagens da câmera',
    'Pode ver as imagens da câmera do Hub.',
  ],
  'camera.live': [
    '01a1714d-1b6b-764a-aeec-93d9dbf6f64d',
    'hub',
    'Câmera ao vivo',
    'Pode acompanhar a câmera do Hub ao vivo.',
  ],
  'nodes.view': [
    '01a1714d-1b6b-764a-aeec-9757949b0bb5',
    'hub',
    'Ver dispositivos',
    'Pode ver os dispositivos ligados ao Hub.',
  ],
  'nodes.control': [
    '01a1714d-1b6b-764a-aeec-9895a16ddf2a',
    'hub',
    'Controlar dispositivos',
    'Pode comandar os dispositivos ligados ao Hub.',
  ],
  'mesh.dispatch': [
    '01a1714d-1b6b-764a-aeec-9e890fa2ae4b',
    'hub',
    'Enviar tarefas aos dispositivos',
    'Pode mandar tarefas para a rede de dispositivos do Hub.',
  ],
  'hub.settings': [
    '01a1714d-1b6b-764a-aeec-a3803249a8e3',
    'hub',
    'Configurar o Hub',
    'Pode mudar as configurações do Hub.',
  ],
  'org.members.manage': [
    '01a1714d-1b6b-764a-aeec-a5385013584b',
    'organization',
    'Gerenciar membros',
    'Pode convidar, remover e mudar o papel dos membros da organização.',
  ],
  'org.spaces.create': [
    '01a1714d-1b6b-764a-aeec-a9d525ffe4b4',
    'organization',
    'Criar espaços',
    'Pode criar novos espaços na organização.',
  ],
  'org.hubs.approve': [
    '01a1714d-1b6b-764a-aeec-ac83b310a005',
    'organization',
    'Aprovar Hubs',
    'Pode aprovar a ligação de Hubs à organização.',
  ],
  'org.billing': [
    '01a1714d-1b6b-764a-aeec-b3fdf56b974b',
    'organization',
    'Cobrança e plano',
    'Pode ver e mudar o plano e a cobrança da organização.',
  ],
} as const;

const CATALOG_ROLES = {
  org_admin: [
    '01a1714d-1b6b-764a-aeec-b6454eea23ed',
    'organization',
    'Administrador',
    'Pode gerenciar a organização, os membros e a cobrança.',
  ],
  org_member: [
    '01a1714d-1b6c-7394-b728-aef4d21b572f',
    'organization',
    'Membro',
    'Participa da organização e entra nos espaços por convite.',
  ],
  space_reader: [
    '01a1714d-1b6c-7394-b728-b07f953ffe3e',
    'space',
    'Leitor',
    'Pode ver as memórias do espaço.',
  ],
  space_editor: [
    '01a1714d-1b6c-7394-b728-b5a6b57e3fb8',
    'space',
    'Editor',
    'Pode ver e editar as memórias do espaço.',
  ],
  space_manager: [
    '01a1714d-1b6c-7394-b728-b9dd9acd3245',
    'space',
    'Gestor',
    'Pode editar as memórias e cuidar de quem participa do espaço.',
  ],
  hub_owner: [
    '01a1714d-1b6c-7394-b728-bdd3f249677b',
    'hub',
    'Dono',
    'Pode tudo no Hub.',
  ],
  hub_operator: [
    '01a1714d-1b6c-7394-b728-c2c679781ab8',
    'hub',
    'Operador',
    'Pode conversar, ver a câmera e controlar os dispositivos.',
  ],
  hub_user: [
    '01a1714d-1b6c-7394-b728-c59d4087654a',
    'hub',
    'Usuário',
    'Pode ver e conversar.',
  ],
  hub_room: [
    '01a1714d-1b6c-7394-b728-c860760128b2',
    'hub',
    'Sala',
    'Quem está na sala pode conversar por voz.',
  ],
} as const;

const CATALOG_ROLE_PERMISSIONS: Record<
  keyof typeof CATALOG_ROLES,
  (keyof typeof CATALOG_PERMISSIONS)[]
> = {
  org_admin: [
    'org.members.manage',
    'org.spaces.create',
    'org.hubs.approve',
    'org.billing',
  ],
  org_member: [],
  space_reader: ['memory.read'],
  space_editor: ['memory.read', 'memory.write'],
  space_manager: [
    'memory.read',
    'memory.write',
    'memory.delete',
    'space.members.manage',
  ],
  hub_owner: [
    'chat.voice',
    'chat.live',
    'camera.view',
    'camera.live',
    'nodes.view',
    'nodes.control',
    'mesh.dispatch',
    'hub.settings',
  ],
  hub_operator: [
    'chat.voice',
    'chat.live',
    'camera.view',
    'camera.live',
    'nodes.view',
    'nodes.control',
    'mesh.dispatch',
  ],
  hub_user: ['chat.voice', 'chat.live', 'nodes.view'],
  hub_room: ['chat.voice'],
};

const CATALOG_DEPENDENCIES: [
  keyof typeof CATALOG_PERMISSIONS,
  keyof typeof CATALOG_PERMISSIONS,
][] = [
  ['camera.live', 'camera.view'],
  ['nodes.control', 'nodes.view'],
];

async function seedRbacCatalog(db: Queryable): Promise<void> {
  for (const [key, [id, scope, name, description]] of Object.entries(
    CATALOG_PERMISSIONS,
  )) {
    await db.query(
      `INSERT INTO "permissions" ("id", "key", "scope_type", "name", "description") VALUES ($1, $2, $3, $4, $5)`,
      [id, key, scope, name, description],
    );
  }
  for (const [key, [id, scope, name, description]] of Object.entries(
    CATALOG_ROLES,
  )) {
    await db.query(
      `INSERT INTO "roles" ("id", "scope_type", "key", "name", "description") VALUES ($1, $2, $3, $4, $5)`,
      [id, scope, key, name, description],
    );
  }
  for (const [role, perms] of Object.entries(CATALOG_ROLE_PERMISSIONS)) {
    for (const perm of perms) {
      await db.query(
        `INSERT INTO "role_permission" ("role_id", "permission_id") VALUES ($1, $2)`,
        [
          CATALOG_ROLES[role as keyof typeof CATALOG_ROLES][0],
          CATALOG_PERMISSIONS[perm][0],
        ],
      );
    }
  }
  for (const [perm, requires] of CATALOG_DEPENDENCIES) {
    await db.query(
      `INSERT INTO "permission_dependency" ("permission_id", "requires_permission_id") VALUES ($1, $2)`,
      [CATALOG_PERMISSIONS[perm][0], CATALOG_PERMISSIONS[requires][0]],
    );
  }
}

async function removeRbacCatalog(db: Queryable): Promise<void> {
  const roleIds = Object.values(CATALOG_ROLES).map((r) => r[0]);
  const permIds = Object.values(CATALOG_PERMISSIONS).map((p) => p[0]);
  await db.query(
    `DELETE FROM "permission_dependency" WHERE "permission_id" = ANY($1)`,
    [permIds],
  );
  await db.query(`DELETE FROM "role_permission" WHERE "role_id" = ANY($1)`, [
    roleIds,
  ]);
  await db.query(`DELETE FROM "roles" WHERE "id" = ANY($1)`, [roleIds]);
  await db.query(`DELETE FROM "permissions" WHERE "id" = ANY($1)`, [permIds]);
}

const COMMON = `
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE`;

export class CreateRbacCatalog1792894200000 implements MigrationInterface {
  name = 'CreateRbacCatalog1792894200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "permissions" (
        "id" uuid NOT NULL DEFAULT uuidv7(),${COMMON},
        "key" character varying(100) NOT NULL,
        "scope_type" character varying(20) NOT NULL,
        "name" character varying(255) NOT NULL,
        "description" character varying(500),
        CONSTRAINT "PK_permissions" PRIMARY KEY ("id"),
        CONSTRAINT "ck_permissions_scope_type" CHECK ("scope_type" IN ('organization', 'space', 'hub'))
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_permissions_key" ON "permissions" ("key")`,
    );
    await addSyncVersionTrigger(queryRunner, 'permissions');

    await queryRunner.query(`
      CREATE TABLE "permission_dependency" (
        "permission_id" uuid NOT NULL,
        "requires_permission_id" uuid NOT NULL,${COMMON},
        CONSTRAINT "PK_permission_dependency" PRIMARY KEY ("permission_id", "requires_permission_id"),
        CONSTRAINT "fk_permission_dependency_permissions" FOREIGN KEY ("permission_id") REFERENCES "permissions" ("id"),
        CONSTRAINT "fk_permission_dependency_requires" FOREIGN KEY ("requires_permission_id") REFERENCES "permissions" ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "fk_permission_dependency_requires_idx" ON "permission_dependency" ("requires_permission_id")`,
    );
    await addSyncVersionTrigger(queryRunner, 'permission_dependency');

    // organization_id ganha a FK para organizations na migration que cria essa tabela.
    await queryRunner.query(`
      CREATE TABLE "roles" (
        "id" uuid NOT NULL DEFAULT uuidv7(),${COMMON},
        "organization_id" uuid,
        "scope_type" character varying(20) NOT NULL,
        "key" character varying(50),
        "name" character varying(255) NOT NULL,
        "description" character varying(500),
        "copied_from_role_id" uuid,
        "permissions_reviewed_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_roles" PRIMARY KEY ("id"),
        CONSTRAINT "ck_roles_scope_type" CHECK ("scope_type" IN ('organization', 'space', 'hub')),
        CONSTRAINT "fk_roles_copied_from" FOREIGN KEY ("copied_from_role_id") REFERENCES "roles" ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_roles_factory_key" ON "roles" ("key") WHERE "organization_id" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_roles_organization_key" ON "roles" ("organization_id", "key") WHERE "organization_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "fk_roles_copied_from_idx" ON "roles" ("copied_from_role_id")`,
    );
    await addSyncVersionTrigger(queryRunner, 'roles');

    await queryRunner.query(`
      CREATE TABLE "role_permission" (
        "role_id" uuid NOT NULL,
        "permission_id" uuid NOT NULL,${COMMON},
        CONSTRAINT "PK_role_permission" PRIMARY KEY ("role_id", "permission_id"),
        CONSTRAINT "fk_role_permission_roles" FOREIGN KEY ("role_id") REFERENCES "roles" ("id"),
        CONSTRAINT "fk_role_permission_permissions" FOREIGN KEY ("permission_id") REFERENCES "permissions" ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "fk_role_permission_permissions_idx" ON "role_permission" ("permission_id")`,
    );
    await addSyncVersionTrigger(queryRunner, 'role_permission');

    await seedRbacCatalog(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await removeRbacCatalog(queryRunner);
    await dropSyncVersionTrigger(queryRunner, 'role_permission');
    await queryRunner.query(`DROP INDEX "fk_role_permission_permissions_idx"`);
    await queryRunner.query(`DROP TABLE "role_permission"`);
    await dropSyncVersionTrigger(queryRunner, 'roles');
    await queryRunner.query(`DROP INDEX "fk_roles_copied_from_idx"`);
    await queryRunner.query(`DROP INDEX "uq_roles_organization_key"`);
    await queryRunner.query(`DROP INDEX "uq_roles_factory_key"`);
    await queryRunner.query(`DROP TABLE "roles"`);
    await dropSyncVersionTrigger(queryRunner, 'permission_dependency');
    await queryRunner.query(
      `DROP INDEX "fk_permission_dependency_requires_idx"`,
    );
    await queryRunner.query(`DROP TABLE "permission_dependency"`);
    await dropSyncVersionTrigger(queryRunner, 'permissions');
    await queryRunner.query(`DROP INDEX "uq_permissions_key"`);
    await queryRunner.query(`DROP TABLE "permissions"`);
  }
}
