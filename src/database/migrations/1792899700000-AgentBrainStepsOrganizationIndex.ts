import { MigrationInterface, QueryRunner } from 'typeorm';

// Índice de apoio à FK `fk_agent_brain_steps_organizations` (revisão final do agente do PC): a migration
// CreateAgentBrainSteps criou a FK sem o índice `fk_…_idx` que as outras tabelas têm (apagar/checar a organização
// varreria a tabela inteira).
export class AgentBrainStepsOrganizationIndex1792899700000 implements MigrationInterface {
  name = 'AgentBrainStepsOrganizationIndex1792899700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "fk_agent_brain_steps_organizations_idx" ON "agent_brain_steps" ("organization_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "fk_agent_brain_steps_organizations_idx"`,
    );
  }
}
