import { MigrationInterface, QueryRunner } from 'typeorm';

// FKs compostas com organization_id: a checagem de FK ignora o RLS, então com FK simples uma linha da
// organização A podia apontar para um espaço/versão/convite da B (bloqueio cruzado pelos índices únicos e
// oráculo de existência). Com (filho_id, organization_id) -> (pai.id, pai.organization_id), o pai precisa ser
// da mesma organização. MATCH SIMPLE (padrão): linha com alguma coluna nula não é checada (role_assignments
// sem space_id, pendência sem convite).
type Fk = {
  table: string;
  name: string;
  column: string;
  parent: string;
};

const PARENTS: [table: string, constraint: string][] = [
  ['spaces', 'uq_spaces_id_organization'],
  ['space_keys', 'uq_space_keys_id_organization'],
  ['organization_invitations', 'uq_organization_invitations_id_organization'],
];

const FKS: Fk[] = [
  {
    table: 'space_keys',
    name: 'fk_space_keys_spaces',
    column: 'space_id',
    parent: 'spaces',
  },
  {
    table: 'space_key_grants',
    name: 'fk_space_key_grants_space_keys',
    column: 'space_key_id',
    parent: 'space_keys',
  },
  {
    table: 'space_pending_grants',
    name: 'fk_space_pending_grants_spaces',
    column: 'space_id',
    parent: 'spaces',
  },
  {
    table: 'invitation_space_intents',
    name: 'fk_invitation_space_intents_spaces',
    column: 'space_id',
    parent: 'spaces',
  },
  {
    table: 'role_assignments',
    name: 'fk_role_assignments_spaces',
    column: 'space_id',
    parent: 'spaces',
  },
  {
    table: 'space_pending_grants',
    name: 'fk_space_pending_grants_invitations',
    column: 'invitation_id',
    parent: 'organization_invitations',
  },
  {
    table: 'invitation_space_intents',
    name: 'fk_invitation_space_intents_invitations',
    column: 'invitation_id',
    parent: 'organization_invitations',
  },
];

export class SpacesCompositeOrgFks1792894600000 implements MigrationInterface {
  name = 'SpacesCompositeOrgFks1792894600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [table, constraint] of PARENTS) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${constraint}" UNIQUE ("id", "organization_id")`,
      );
    }
    for (const fk of FKS) {
      await queryRunner.query(
        `ALTER TABLE "${fk.table}" DROP CONSTRAINT "${fk.name}"`,
      );
      await queryRunner.query(
        `ALTER TABLE "${fk.table}" ADD CONSTRAINT "${fk.name}" FOREIGN KEY ("${fk.column}", "organization_id") REFERENCES "${fk.parent}" ("id", "organization_id")`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const fk of [...FKS].reverse()) {
      await queryRunner.query(
        `ALTER TABLE "${fk.table}" DROP CONSTRAINT "${fk.name}"`,
      );
      await queryRunner.query(
        `ALTER TABLE "${fk.table}" ADD CONSTRAINT "${fk.name}" FOREIGN KEY ("${fk.column}") REFERENCES "${fk.parent}" ("id")`,
      );
    }
    for (const [table, constraint] of [...PARENTS].reverse()) {
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP CONSTRAINT "${constraint}"`,
      );
    }
  }
}
