# Versões do `GET /hub/sync` na ordem dos commits — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a sincronização do Hub (`GET /hub/sync`) nunca mais pula uma linha cujo commit chegou atrasado: as dez
tabelas que ela lê passam a receber o `sync_version` **no COMMIT, na ordem dos commits**, pelo mesmo mecanismo dos
assuntos.

**Architecture:** reaproveita `addCommitOrderedSyncVersion` (`src/shared/infra/db/migration-helpers.ts`), já em uso nas
cinco tabelas dos assuntos (migration `ConversationFeedCommitOrder`): toda gravação deixa a linha provisória
(`sync_pending = true`) e um constraint trigger adiado dá a versão no COMMIT, de uma sequência, sob um advisory lock.
Duas mudanças no mecanismo: (1) chave composta (três tabelas não têm `id`), passada como argumentos do trigger;
(2) **um feed só**: as tabelas do Hub usam a MESMA sequência e o MESMO advisory lock dos assuntos. Lock compartilhado é
obrigatório: muitas transações gravam nos dois grupos (desregistro de Hub, saída de espaço/organização, desligar a
nuvem), e os triggers adiados disparam na ordem em que as linhas foram gravadas; com dois locks, T1 (assunto, depois
espaço) e T2 (espaço, depois assunto) dariam deadlock no COMMIT. Com um lock, uma sequência basta (cursores dos dois
feeds só ganham lacunas).

**Tech Stack:** PostgreSQL 18 (triggers, RLS, advisory locks), TypeORM 1.x migrations, Vitest e2e.

**Spec:** não há spec própria. A decisão de produto é a mesma que o Jonas tomou para os assuntos (opção b, versão no
COMMIT; plano `docs/superpowers/plans/2026-11-09-conversations.md`). Fontes: `CLAUDE.md` → "Pendências antes de
produção" → "Ordem de commit × `sync_version`"; o comentário de `addCommitOrderedSyncVersion` e
`createCommitOrderedSyncFunctions` (mecanismo, custo, RLS); a migration
`src/database/migrations/1792897300000-ConversationFeedCommitOrder.ts` (modelo da migration nova).

## Global Constraints

- Tabelas (as que o `HubSyncSqlReader` lê) e chave de cada uma: `hubs (id)`, `organizations (id)`, `users (id)`,
  `role_assignments (id)`, `spaces (id)`, `space_keys (id)`, `space_key_grants (id)`,
  `hub_organization (organization_id, hub_id)`, `hub_space (space_id, hub_id)`, `user_organization (organization_id, user_id)`.
- As tabelas do catálogo RBAC (`roles`, `permissions`, `permission_dependency`, `role_permission`) **ficam** na
  sequência global `sync_version_seq` (nenhum feed as lê; ninguém grava nelas em execução).
- Sequência e lock: os do feed dos assuntos, sem mudar nome nem valor: `conversation_sync_version_seq`,
  lockKey `6005917628874313302`. O nome da sequência fica (renomear exigiria recriar os cinco triggers dos assuntos);
  o código passa a chamá-la `COMMIT_ORDERED_SYNC_FEED`.
- Cursores já entregues continuam valendo: a sequência só sobe (`setval` para o maior entre o valor atual dela e o
  maior `sync_version` das dez tabelas), com as dez tabelas travadas antes da leitura.
- Sem `SECURITY DEFINER`; o login de runtime continua sem `DELETE` nessas tabelas.
- `sync_version` cabe em número JSON exato (`toJsonNumber` no `hub-sync.controller.ts` já recusa acima de 2^53).
- Mensagens de commit em inglês (Conventional Commits); comentários de migration em português, como os vizinhos.

## Review Focus

1. **Gravação num contexto que não vê mais a linha** (o dono desregistra o Hub e grava lápide em papéis de outras
   organizações; quem sai da organização grava a lápide do próprio vínculo): a linha precisa sair do COMMIT com
   versão, não presa em `sync_pending`. Coberto pelas policies `sync_commit_*` e pela checagem de linhas pendentes no
   reset de todo e2e (Task 1) e pelo teste de cascata da Task 2.
2. **Gravação pelo contexto do Hub em `hubs`**, que só tem GRANT de UPDATE por coluna: sem GRANT nas colunas
   `sync_version`/`sync_pending` o UPDATE do COMMIT dá 42501 e a requisição do Hub falha. Teste "PUT /hub/storage" na
   Task 2.
3. **Transação que grava nos dois grupos em ordens opostas** (assunto→espaço e espaço→assunto ao mesmo tempo): nunca
   deadlock. Teste na Task 2.
4. **Linha de chave composta gravada duas vezes na mesma transação** (`hub_organization` aprovado e depois revogado no
   mesmo `uow.run`, upsert que reativa a lápide): uma versão só, a da última gravação, e nada pendente. Teste na Task 1.
5. **Cursor antigo do Hub depois da migration:** uma passada incremental com o `nextSince` de antes recebe só o que
   mudou depois, nunca menos. Teste na Task 2.

---

### Task 1: mecanismo generalizado e migration das dez tabelas

**Files:**
- Modify: `src/shared/infra/db/migration-helpers.ts` (feed único, chave composta, policies só com RLS ligado)
- Create: `src/database/migrations/1792898700000-HubSyncCommitOrder.ts`
- Modify: `src/shared/infra/db/base.entity.ts` (base nova com `syncPending`)
- Modify: `src/identity/infra/db/user.entity.ts`, `src/organizations/infra/db/organization.entity.ts`,
  `src/organizations/infra/db/role-assignment.entity.ts`, `src/organizations/infra/db/user-organization.entity.ts`,
  `src/spaces/infra/db/space.entity.ts`, `src/spaces/infra/db/space-key.entity.ts`,
  `src/spaces/infra/db/space-key-grant.entity.ts`, `src/hubs/infra/db/hub.entity.ts`,
  `src/hubs/infra/db/hub-organization.entity.ts`, `src/hubs/infra/db/hub-space.entity.ts`
- Modify: `test/setup/commit-order-check.ts` (lista das quinze tabelas)
- Modify: `test/conversations/commit-order-invariants.e2e-spec.ts` → mover para
  `test/shared/commit-order-invariants.e2e-spec.ts` (agora cobre as quinze)

**Interfaces:**
- Produces (em `migration-helpers.ts`):
  - `export const COMMIT_ORDERED_SYNC_FEED: CommitOrderedSyncFeed = { sequence: 'conversation_sync_version_seq', lockKey: '6005917628874313302' }`;
    `CONVERSATION_SYNC_FEED` continua exportado como `= COMMIT_ORDERED_SYNC_FEED` (migrations antigas o importam).
  - `addCommitOrderedSyncVersion(qr, table, feed, keyColumns: readonly string[] = ['id']): Promise<void>` — passa as
    colunas como argumentos extras do trigger quando diferentes de `['id']`; cria `sync_commit_read`/`sync_commit_update`
    só se a tabela tem `relrowsecurity` (em `users`, sem RLS, nenhuma policy).
  - `replaceAssignCommitSyncVersion(qr): Promise<void>` — `CREATE OR REPLACE` de `assign_commit_sync_version()` aceitando
    chave composta; os triggers dos assuntos (dois argumentos) continuam funcionando sem ser recriados.
- Produces (em `test/setup/commit-order-check.ts`): `COMMIT_ORDERED_TABLES` com as quinze tabelas (as cinco dos
  assuntos + as dez do Hub), usada pela Task 2.
- Produces (em `base.entity.ts`): `CommitOrderedSyncableTypeormEntity extends SyncableTypeormEntity` com
  `syncPending` declarado exatamente como em `DeviceIdSyncableTypeormEntity`
  (`boolean, default: true, insert: false, update: false, select: false`).

- [ ] **Step 1: Escrever os testes de invariantes (falham)**

  Em `test/shared/commit-order-invariants.e2e-spec.ts` (movido), parametrizar pelas quinze tabelas:
  - `'every RLS table of the feed has the permissive escape policies; every RESTRICTIVE SELECT/UPDATE/ALL policy carries the escape'`:
    para cada tabela com `relrowsecurity`, `sync_commit_read` (`cmd: 'SELECT', qual: 'sync_commit_in_progress()'`) e
    `sync_commit_update` existem; `users` não tem nenhuma das duas; a checagem de policies restritivas fica como está;
    a afirmação "existe alguma restritiva" só para as cinco dos assuntos.
  - `'triggers: ...'` (o existente) para as quinze, e `def` do `trg_<t>_sync_commit` contém
    `COMMIT_ORDERED_SYNC_FEED.lockKey` e, nas três de chave composta, os nomes das colunas na ordem
    (`'organization_id', 'hub_id'` etc.).
  - `'hubs: the runtime may update sync_version and sync_pending (commit-time UPDATE under the column grants)'`:
    `has_column_privilege('app_runtime', 'hubs', c, 'UPDATE')` verdadeiro para as duas colunas.
  - `'a composite-key row written twice in one transaction gets one version, from the shared sequence, and is not left pending'`:
    pelo login de runtime (`appDataSource`/o helper que os e2e de RLS usam), numa transação com
    `app.organization_id` de uma organização com Hub vinculado: `UPDATE hub_organization SET status = 'approved'` e
    depois `UPDATE ... SET deleted_at = now()` na mesma linha; depois do COMMIT: `sync_pending = false` e
    `sync_version > ` o `last_value` da sequência lido antes da transação.
  - O teste de `ConversationFeedSequenceFloor` continua igual (só o import do caminho muda).

- [ ] **Step 2: Rodar e ver falhar**

  Run: `docker exec vaulter-back-app npx vitest run -c vitest.config.e2e.ts test/shared/commit-order-invariants.e2e-spec.ts`
  Expected: FAIL nas tabelas do Hub (sem `sync_pending`, sem `trg_<t>_sync_commit`).

- [ ] **Step 3: Helpers**

  `addCommitOrderedSyncVersion` ganha `keyColumns` e a condição de RLS descritas em Interfaces. Corpo novo de
  `assign_commit_sync_version` (o único trecho que a assinatura não determina):

  ```sql
  CREATE OR REPLACE FUNCTION assign_commit_sync_version() RETURNS trigger AS $$
  DECLARE
    cond text;
  BEGIN
    PERFORM pg_advisory_xact_lock(TG_ARGV[0]::bigint);
    -- Key columns: TG_ARGV[2..] (composite primary keys); `id` when there are none (the conversation tables).
    SELECT string_agg(format('%I = ($1).%I', k, k), ' AND ') INTO cond
      FROM unnest(CASE WHEN TG_NARGS > 2 THEN TG_ARGV[2:TG_NARGS - 1] ELSE ARRAY['id'] END) AS k;
    PERFORM set_config('app.sync_commit', 'on', true);
    EXECUTE format(
      'UPDATE %I.%I SET sync_version = nextval(%L::regclass), sync_pending = false WHERE %s AND sync_pending',
      TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_ARGV[1], cond
    ) USING NEW;
    PERFORM set_config('app.sync_commit', '', true);
    RETURN NULL;
  END
  $$ LANGUAGE plpgsql SECURITY INVOKER
  ```

  Conferir no psql antes de seguir que `TG_ARGV[2:TG_NARGS - 1]` e `($1).col` com `USING NEW` funcionam (um trigger
  de teste numa tabela temporária basta). Atualizar o comentário de `createCommitOrderedSyncFunctions` (COST): o lock
  agora serializa os commits de **todas** as tabelas dos dois feeds, e o motivo do lock único (deadlock entre feeds).

- [ ] **Step 4: Migration `HubSyncCommitOrder1792898700000`**

  `up`, nesta ordem (modelo: `ConversationFeedCommitOrder`):
  1. `LOCK TABLE <as dez> IN SHARE ROW EXCLUSIVE MODE`;
  2. `SELECT setval('conversation_sync_version_seq', GREATEST((SELECT last_value FROM conversation_sync_version_seq), <maior sync_version das dez>))`;
  3. `replaceAssignCommitSyncVersion`;
  4. `GRANT UPDATE (sync_version, sync_pending) ON hubs TO app_runtime` **depois** de criar a coluna (fazer o GRANT
     logo após o `addCommitOrderedSyncVersion` de `hubs`);
  5. `addCommitOrderedSyncVersion(qr, t, COMMIT_ORDERED_SYNC_FEED, keys)` para cada tabela da lista de Global
     Constraints.

  `down`: trava as dez, `dropCommitOrderedSyncVersion` + recria `trg_<t>_sync_version` com `set_sync_version()` em cada
  uma, `REVOKE UPDATE (sync_version) ON hubs FROM app_runtime` (a coluna `sync_pending` some com o drop),
  `setval('sync_version_seq', GREATEST(last_value, <maior sync_version das dez>))` para os cursores continuarem
  válidos, e deixa a função generalizada (compatível com os triggers dos assuntos). Comentário de cabeçalho em
  português: o quê, o lock único e o porquê (deadlock), a sequência compartilhada, o GRANT de `hubs`.

- [ ] **Step 5: Entidades**

  As sete de chave `id` passam de `SyncableTypeormEntity` para `CommitOrderedSyncableTypeormEntity`; `hub_space`,
  `hub_organization` e `user_organization` declaram `syncPending` inline com as mesmas opções. Atualizar o comentário de
  `SyncableTypeormEntity` ("sequência global" vale só para o catálogo).

- [ ] **Step 6: Lista dos e2e**

  `COMMIT_ORDERED_TABLES` em `test/setup/commit-order-check.ts` com as quinze; comentário do arquivo citando as duas
  migrations.

- [ ] **Step 7: Migrar, conferir drift e rodar**

  Run: `npm run build && docker exec vaulter-back-app sh -c 'npm run migration:run && npm run schema:check'`
  Expected: migration aplicada; `schema:check: OK, no drift`.
  Run: `docker exec vaulter-back-app npx vitest run -c vitest.config.e2e.ts test/shared/commit-order-invariants.e2e-spec.ts test/hubs`
  Expected: PASS (o reset de cada teste também confere que nada ficou `sync_pending`).
  Run: `docker exec vaulter-back-app sh -c 'npm run migration:revert && npm run migration:run'`
  Expected: as duas sem erro (o `down` funciona).

- [ ] **Step 8: Commit**

  ```bash
  git add -A
  git commit -m "feat(hubs): hub sync versions assigned at commit, in commit order"
  ```

### Task 2: comportamento do `GET /hub/sync` e documentação

**Files:**
- Modify: `src/hubs/infra/db/hub-sync.sql-reader.ts` (`AND NOT <alias>.sync_pending` em cada consulta versionada;
  no item `member`, em `uo`, `u` e no `max(ra.sync_version)`)
- Modify: `src/hubs/application/sync-hub.use-case.ts` (comentário do contrato: versões no COMMIT; sem a ressalva)
- Create: `test/hubs/sync-commit-order.e2e-spec.ts`
- Modify: `CLAUDE.md`, `docs/hubs/hub-lifecycle.md`

**Interfaces:**
- Consumes: `COMMIT_ORDERED_SYNC_FEED`, `COMMIT_ORDERED_TABLES` (Task 1); helpers de Hub de `test/support/hub-client.ts`
  (`onboard`, `sync`) e `test/support/hubs-kit.ts`; `adminDataSource` de `test/setup/test-app.ts`.

- [ ] **Step 1: Escrever os testes (o primeiro falha sem a Task 1; com ela, todos devem passar — rodar também com a
  migration revertida para ver o primeiro falhar)**

  Em `test/hubs/sync-commit-order.e2e-spec.ts`, um Hub com dois espaços instalados (A e B) e o cursor drenado:
  - `'inverted commit order: the later commit is served at once, the earlier one comes after it with a higher version; nextSince never skips'`:
    T1 (conexão própria do `adminDataSource`, transação aberta) `UPDATE spaces SET name = 'A2' WHERE id = A`; T2 pela
    HTTP renomeia/atualiza B (ou SQL em outra conexão, confirmada); `sync` traz B e não A; libera T1; `sync` a partir do
    `nextSince` anterior traz A com `syncVersion` > o de B.
  - `'a transaction writing both feeds in opposite orders never deadlocks'`: duas conexões; T1 grava uma linha de
    `conversations` (UPDATE de `updated_at` num assunto existente) e depois `spaces`; T2 grava `spaces` e depois
    `conversations`; `COMMIT` das duas em paralelo; as duas confirmam (nenhum `40P01`) e as linhas ficam com
    `sync_pending = false`.
  - `'a hub-context write (PUT /hub/storage) commits and the hub item comes back with a newer version'`: 204, e o
    próximo `sync` traz o item `hub` com `syncVersion` > cursor.
  - `'cascades written in contexts that no longer see the rows commit with versions: deregister, owner leaving the organization'`:
    desregistrar o Hub (pelo dono) e, noutro Hub, o dono sair da organização vinculada; depois de cada um,
    `SELECT count(*) FROM <t> WHERE sync_pending` = 0 nas dez tabelas (use `COMMIT_ORDERED_TABLES`).
  - `'an old cursor keeps working after the switch: an incremental pass returns only what changed after it'`: grava
    uma mudança e confere que `sync(since = cursor de antes)` traz só itens com `syncVersion > cursor`, incluindo ela.

- [ ] **Step 2: Rodar**

  Run: `docker exec vaulter-back-app npx vitest run -c vitest.config.e2e.ts test/hubs/sync-commit-order.e2e-spec.ts test/hubs/sync.e2e-spec.ts`
  Expected: PASS. Com a migration da Task 1 revertida (só para conferir): o primeiro teste FALHA (A sai com versão
  menor que B e o cursor o pula). Rodar `migration:run` de novo depois.

- [ ] **Step 3: Leitor e contrato**

  Filtros `NOT sync_pending` (documentam a intenção; toda linha confirmada já tem `false`) e o comentário do caso de uso.

- [ ] **Step 4: Documentação**

  - `CLAUDE.md`: tirar a pendência "Ordem de commit × `sync_version`" (deixar só a frase do `since` do backup, que
    continua com a folga de 1 h); em "Sincronização" do módulo `hubs`, dizer que as versões são dadas no COMMIT (mesmo
    feed e mesmo lock dos assuntos); em "Ordem de locks" dos assuntos e em "Banco de dados" (`sync_version`), trocar
    "advisory lock dos assuntos" por "advisory lock dos feeds" e listar as quinze tabelas; registrar o custo: commits que
    gravam em qualquer uma das quinze tabelas são seriais (fsync incluído), e as cascatas fazem os outros esperarem no
    COMMIT; o GRANT de `hubs` (`sync_version`, `sync_pending`).
  - `docs/hubs/hub-lifecycle.md`: tirar a pendência das linhas ~692–694 e, no trecho do `GET /hub/sync`, dizer que o
    feed não pula linhas e não precisa de sincronização completa periódica (a completa continua sendo o jeito de
    recomeçar); manter que o `syncVersion` dos assuntos não é comparável ao do `GET /hub/sync` **como contrato** (os dois
    saem hoje da mesma sequência, mas isso não é promessa).

- [ ] **Step 5: Verificação completa**

  Run: `npm run build && npm test && npm run lint && npm run typecheck && docker exec vaulter-back-app npm run test:e2e`
  Expected: tudo verde (o lint tem um warning antigo em `uploads.use-cases.spec.ts`, não deste trabalho).

- [ ] **Step 6: Commit**

  ```bash
  git add -A
  git commit -m "test(hubs): hub sync never skips a late commit; docs"
  ```
