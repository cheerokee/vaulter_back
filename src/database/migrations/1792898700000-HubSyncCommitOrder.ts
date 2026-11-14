import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  addCommitOrderedSyncVersion,
  COMMIT_ORDERED_SYNC_FEED,
  dropCommitOrderedSyncVersion,
  replaceAssignCommitSyncVersion,
} from '../../shared/infra/db/migration-helpers.js';

// Tabelas lidas pelo `GET /hub/sync` (HubSyncSqlReader) e a chave de cada uma (três não têm `id`).
const TABLES: readonly [table: string, keys: readonly string[]][] = [
  ['hubs', ['id']],
  ['organizations', ['id']],
  ['users', ['id']],
  ['role_assignments', ['id']],
  ['spaces', ['id']],
  ['space_keys', ['id']],
  ['space_key_grants', ['id']],
  ['hub_organization', ['organization_id', 'hub_id']],
  ['hub_space', ['space_id', 'hub_id']],
  ['user_organization', ['organization_id', 'user_id']],
];

// Writers wait from here to the end of the migration: no version is written between reading the max and switching the
// triggers (SHARE ROW EXCLUSIVE conflicts with every INSERT/UPDATE and with itself, not with plain reads).
const LOCK_TABLES = `LOCK TABLE ${TABLES.map(([t]) => `"${t}"`).join(', ')} IN SHARE ROW EXCLUSIVE MODE`;

const MAX_VERSION = `SELECT COALESCE(MAX(v), 0) FROM (${TABLES.map(([t]) => `SELECT MAX(sync_version) AS v FROM "${t}"`).join(' UNION ALL ')}) m`;

// Versões da sincronização do Hub atribuídas NO COMMIT, na ordem dos commits (o mesmo mecanismo dos assuntos,
// ConversationFeedCommitOrder; detalhes em `addCommitOrderedSyncVersion`). Antes a versão vinha da sequência global na
// gravação: uma transação com versão menor que confirmasse depois de outra com versão maior era pulada para sempre pelo
// `nextSince` do Hub (Pendências do CLAUDE.md, "Ordem de commit × sync_version").
// - UM feed só: as dez tabelas usam a MESMA sequência e o MESMO advisory lock dos assuntos (`COMMIT_ORDERED_SYNC_FEED`).
//   Os triggers adiados disparam na ordem em que as linhas foram gravadas; com dois locks, uma transação que grava
//   assunto e depois espaço e outra que grava espaço e depois assunto (desregistro de Hub, saída de espaço/organização,
//   desligar a nuvem) dariam deadlock no COMMIT. Custo: os commits que gravam em qualquer das quinze tabelas são seriais.
// - A sequência só sobe (`setval` para o maior entre o valor dela e o maior `sync_version` das dez tabelas, já travadas):
//   os cursores dos Hubs continuam valendo; os dos assuntos só ganham lacunas.
// - `assign_commit_sync_version` aceita chave composta (`replaceAssignCommitSyncVersion`); os triggers dos assuntos
//   (só `id`) continuam iguais.
// - `hubs` só tem GRANT de UPDATE por coluna: o UPDATE do COMMIT precisa de `sync_version` e `sync_pending`.
// - `users` não tem RLS: sem as policies de escape.
// - O catálogo RBAC (roles, permissions...) fica na sequência global (nenhum feed o lê).
// `down`: volta à versão na gravação (sequência global, acima de toda versão já servida) e deixa a função generalizada
// (compatível com os triggers dos assuntos).
export class HubSyncCommitOrder1792898700000 implements MigrationInterface {
  name = 'HubSyncCommitOrder1792898700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(LOCK_TABLES);
    const seq = COMMIT_ORDERED_SYNC_FEED.sequence;
    await queryRunner.query(
      `SELECT setval('${seq}', GREATEST((SELECT last_value FROM "${seq}"), (${MAX_VERSION})))`,
    );
    await replaceAssignCommitSyncVersion(queryRunner);
    for (const [table, keys] of TABLES) {
      await addCommitOrderedSyncVersion(
        queryRunner,
        table,
        COMMIT_ORDERED_SYNC_FEED,
        keys,
      );
    }
    await queryRunner.query(
      `GRANT UPDATE ("sync_version", "sync_pending") ON "hubs" TO app_runtime`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(LOCK_TABLES);
    await queryRunner.query(
      `REVOKE UPDATE ("sync_version", "sync_pending") ON "hubs" FROM app_runtime`,
    );
    for (const [table] of TABLES) {
      await dropCommitOrderedSyncVersion(queryRunner, table);
      await queryRunner.query(
        `CREATE TRIGGER "trg_${table}_sync_version" BEFORE INSERT OR UPDATE ON "${table}" ` +
          `FOR EACH ROW EXECUTE FUNCTION set_sync_version()`,
      );
    }
    await queryRunner.query(
      `SELECT setval('sync_version_seq', GREATEST((SELECT last_value FROM sync_version_seq), (${MAX_VERSION})))`,
    );
  }
}
