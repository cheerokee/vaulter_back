import { MigrationInterface, QueryRunner } from 'typeorm';

// Catálogo de ferramentas do agente do PC (spec pc-agent §5.4): o que o agente (um Hub `pc`) sabe fazer. Metadado de
// software, não conteúdo de cliente, então fica legível; `PUT /hub/agent/tools` substitui a lista (lápide no que saiu,
// upsert do resto: um nome que volta revive a linha). Não sincroniza (sem `sync_version`) nem tem `organization_id`:
// o Hub não é de organização.
// `owner_user_id` é cópia desnormalizada do dono para a policy (FK composta com `hubs (id, owner_user_id)`, como
// `hub_organization.hub_owner_user_id`; numa transferência de Hub futura, atualizar).
// RLS: o dono do Hub (`app.user_id`) ou o próprio Hub (`app.hub_id`), leitura e escrita. A lista por organização é lida
// no contexto de cada Hub vinculado (como `HubRepository.namesOf`), depois de conferir `org.agents.manage`.
const USER = `NULLIF(current_setting('app.user_id', true), '')::uuid`;
const HUB = `NULLIF(current_setting('app.hub_id', true), '')::uuid`;

export class CreateAgentTools1792899100000 implements MigrationInterface {
  name = 'CreateAgentTools1792899100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "agent_tools" (
        "id" uuid NOT NULL DEFAULT uuidv7(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        "hub_id" uuid NOT NULL,
        "owner_user_id" uuid NOT NULL,
        "name" character varying(200) NOT NULL,
        "title" character varying(200) NOT NULL,
        "description" text NOT NULL,
        "input_schema" jsonb NOT NULL,
        "category" character varying(16) NOT NULL,
        CONSTRAINT "PK_agent_tools" PRIMARY KEY ("id"),
        CONSTRAINT "uq_agent_tools_hub_name" UNIQUE ("hub_id", "name"),
        CONSTRAINT "ck_agent_tools_category" CHECK ("category" IN ('mcp', 'browser', 'folder')),
        CONSTRAINT "fk_agent_tools_hubs" FOREIGN KEY ("hub_id", "owner_user_id") REFERENCES "hubs" ("id", "owner_user_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "fk_agent_tools_hubs_idx" ON "agent_tools" ("hub_id", "owner_user_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_tools" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_tools" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `CREATE POLICY "owner_or_hub" ON "agent_tools"
         USING (owner_user_id = ${USER} OR hub_id = ${HUB})
         WITH CHECK (owner_user_id = ${USER} OR hub_id = ${HUB})`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY "owner_or_hub" ON "agent_tools"`);
    await queryRunner.query(`DROP TABLE "agent_tools"`);
  }
}
