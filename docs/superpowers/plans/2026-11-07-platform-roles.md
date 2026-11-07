# Papéis da plataforma — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Módulo `platform`: papéis da equipe (admin, suporte, financeiro), trava das rotas `/platform/*`, auditoria própria, e pedidos de suporte (desregistro forçado de Hub, nomear admin de organização) com motivo/prova e aprovação dupla para o suporte.

**Architecture:** Módulo novo `src/platform/` (domain/application/infra) que depende de `identity`, `organizations` e `hubs` só pelo que eles exportam da `application/`. `hubs` e `organizations` ganham operações administrativas exportadas que recebem a autorização já feita e uma **origem de auditoria** (`AuditActor`) levada até cada gravação. Catálogo em código + migration imutável; tabelas `platform_*` sem RLS e sem sincronização, protegidas por GRANT.

**Tech Stack:** NestJS 12, TypeScript 6 (ESM), TypeORM 1.x + Postgres 18, Vitest + supertest, `@nestjs/throttler`, `pg` (comando de linha).

**Spec:** `docs/superpowers/specs/2026-11-07-platform-roles-design.md` (leia junto; é a autoridade).

## Global Constraints

- Docs pt-BR; código/logs/commits em inglês (Conventional Commits). Tudo na `develop`; `git push origin develop` depois de cada commit.
- Fronteira: `platform -> identity, organizations, hubs` (e `spaces` só indiretamente via `hubs`); nenhum deles importa `platform`. Nada de importar `infra/` de outro módulo.
- Domínio puro; casos de uso `@Injectable()` dependendo de contratos (classes abstratas); repositórios com `currentManager(this.dataSource)` por operação; mutações em `uow.run`.
- Nenhum papel da plataforma abre conteúdo, cópia trancada, kit ou chave; nada de `platform_*` em resposta de cliente nem na sincronização do Hub.
- Sem papel da plataforma (ou sem a permissão da rota): **404** nas rotas `/platform/*` (não revela que existem).
- Pedir, aprovar e recusar pedido de suporte e mudar papéis exigem `currentAuthProof` + `@ThrottleReauth()`.
- Linhas do `audit_logs` de organização gravadas por ação da plataforma: `user_id = NULL` e `metadata` com `{ actor: 'platform', supportRequestId }`.
- Papéis: `platform_admin` (todas), `platform_support` (`platform.support.request`, `platform.audit.read`), `platform_finance` (nenhuma). Permissões: `platform.roles.manage`, `platform.support.request`, `platform.support.approve`, `platform.support.execute_alone`, `platform.audit.read`.
- Pedido: tipos `hub_force_deregister` | `org_appoint_admin`; estados `pending`, `executed`, `rejected`, `expired`, `failed`; `reason` e `evidence` obrigatórios (1..2000 chars); pendente vence em **7 dias**.
- Antes de cada commit: `npm run build && npm test && npm run lint && npm run typecheck`; com banco/HTTP também, no container, `npm run migration:run`, `npm run schema:check`, `npm run test:e2e`.

## Review Focus

1. **Alvo da nomeação ganha papel da plataforma depois do pedido**: a aprovação recusa (`staff-cannot-be-appointed`) e o pedido não executa. → teste na Task 4.
2. **Pedido de desregistro de um Hub que o dono já desregistrou** (ou id inexistente): o pedido fica `failed` com o `type` do erro, nada muda, a resposta é 200 com o pedido (não 500). → teste na Task 4.
3. **Papel retirado no meio do caminho**: o atendente perde `platform_support` e a próxima chamada já dá 404 (leitura no banco a cada requisição). → teste na Task 2.
4. **Último admin da plataforma retira o próprio papel** (ou outro admin retira o último): 422 `last-platform-admin`, mesmo com duas requisições concorrentes (trava das linhas de admin). → teste na Task 2.
5. **Pedido pendente vencido** sendo aprovado no 8º dia: 422 (`support-request-expired`) e estado `expired`. → teste na Task 4.

---

### Task 1: Catálogo, tabelas e migration

**Files:**
- Create: `src/platform/domain/platform-catalog.ts` (+ `.spec.ts`), `src/platform/infra/db/platform-role.entity.ts`, `platform-permission.entity.ts`, `platform-role-permission.entity.ts`, `user-platform-role.entity.ts`, `platform-support-request.entity.ts`, `platform-audit-log.entity.ts`, `src/platform/platform.module.ts` (só `TypeOrmModule.forFeature` por enquanto), registrar no `AppModule`
- Create: `src/database/migrations/1792895600000-CreatePlatformRoles.ts`
- Modify: `docs/der_model.sql` e `docs/der_model.mwb` (XML, como nos módulos anteriores)
- Test: `test/platform/catalog.e2e-spec.ts`

**Interfaces:**
- Produces:
  - `PLATFORM_PERMISSIONS` (as 5 chaves), `PLATFORM_ROLES` (`platform_admin`, `platform_support`, `platform_finance`, cada um com `name` de exibição em pt-BR e a lista de permissões da Global Constraints), tipos `PlatformPermission`, `PlatformRoleKey`, `isPlatformRoleKey(s)`.
  - Tabelas (todas com `id` uuid v7, `created_at/updated_at/deleted_at`, sem `sync_version`, sem RLS):
    - `platform_roles` (`key` varchar(50) único entre vivos, `name`); `platform_permissions` (`key` varchar(100) único); `platform_role_permission` (`platform_role_id`, `platform_permission_id`, PK composta);
    - `user_platform_role` (PK `user_id, platform_role_id`, FKs para `users`/`platform_roles`; lápide ao retirar, `deleted_at` limpo ao dar de novo);
    - `platform_support_requests` (`type`, `status` com CHECKs; `requested_by_user_id` NOT NULL; `target_hub_id`, `target_organization_id`, `target_user_id` nuláveis com CHECK por tipo: desregistro = só `target_hub_id`; nomeação = `target_organization_id` + `target_user_id`; `reason`, `evidence` text NOT NULL; `decided_by_user_id`, `decided_at`, `decision_note`, `executed_at`, `failure_type` varchar(100), `expires_at` NOT NULL; índice `(status, created_at)`);
    - `platform_audit_logs` (`user_id` nulável — nulo = comando de linha; `action` varchar(100); `support_request_id`, `target_user_id`, `target_hub_id`, `target_organization_id` nuláveis; `result` CHECK `success|denied|error`; `metadata` jsonb; índice `created_at`).
  - Migration: cria tudo, semeia catálogo (papéis + permissões + ligações, ids fixos uuid v7 escritos na migration), GRANTs para `app_runtime`: `SELECT` em `platform_roles`, `platform_permissions`, `platform_role_permission`; `SELECT, INSERT, UPDATE` em `user_platform_role`, `platform_support_requests`; `SELECT, INSERT` em `platform_audit_logs`. `down` desfaz.
- [ ] **Step 1: Testes que falham**
  - `platform-catalog.spec.ts`: `platform_admin` tem as 5; `platform_support` exatamente `platform.support.request` + `platform.audit.read`; `platform_finance` vazio; toda permissão citada existe em `PLATFORM_PERMISSIONS`.
  - `catalog.e2e-spec.ts`: banco == `PLATFORM_ROLES` (papéis, permissões e ligações); o login de runtime não consegue `INSERT` em `platform_roles` nem `UPDATE`/`DELETE` em `platform_audit_logs` (erro de permissão `42501`); `user_platform_role` aceita `INSERT` pelo runtime.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** Implementar catálogo, entidades (todas as constraints nos metadados), migration manual e DER.
- [ ] **Step 4:** no container `migration:run`, `schema:check`, `test:e2e`; no host build/test/lint/typecheck → verde.
- [ ] **Step 5: Commit** `feat(platform): platform roles catalog and tables`.

### Task 2: Acesso da equipe, papéis, auditoria da plataforma e primeiro admin

**Files:**
- Create: `src/platform/domain/platform-role.repository.ts`, `platform-audit-log.repository.ts`; `src/platform/application/platform-access.ts` (+ spec), `platform-audit.ts`, `get-platform-me.use-case.ts`, `list-staff.use-case.ts`, `grant-platform-role.use-case.ts`, `revoke-platform-role.use-case.ts` (+ specs); `src/platform/infra/db/*.typeorm-repository.ts`, mappers; `src/platform/infra/http/platform-permission.decorator.ts` (`@RequirePlatformPermission(p)`), `platform-permission.guard.ts`, `platform-me.controller.ts`, `platform-staff.controller.ts`, `dto/`
- Create: `scripts/platform-grant-admin.ts` (+ script `platform:grant-admin` no `package.json`)
- Test: `test/platform/staff.e2e-spec.ts`, `test/support/platform-kit.ts` (dar papel direto no banco para os testes, chamar rotas)

**Interfaces:**
- Produces:
  - `PlatformRoleRepository`: `permissionsOf(userId): Promise<PlatformPermission[]>`, `rolesOf(userId): Promise<PlatformRoleKey[]>`, `grant(userId, roleKey, now)`, `revoke(userId, roleKey, now)`, `lockAdmins(): Promise<string[]>` (FOR UPDATE nas linhas vivas de `platform_admin`, em ordem de user id), `listStaff(page)`, `hasAnyRole(userId): Promise<boolean>`.
  - `PlatformAccess` (exportado do módulo para os casos de uso daqui): `require(userId, permission): Promise<PlatformPermission[]>` → `NotFoundError('not-found')` sem a permissão; `has(userId, permission): Promise<boolean>`.
  - `PlatformAudit.record({ userId: string | null, action, result, supportRequestId?, targetUserId?, targetHubId?, targetOrganizationId?, metadata? })`, ações `platform.role.granted|revoked`, `platform.request.created|approved|rejected|executed|failed|expired`.
  - Guard: rota marcada com `@RequirePlatformPermission(p)` lê `request.auth.userId` e chama `PlatformAccess.require` (a cada requisição, sem cache); `@UseGuards(PlatformPermissionGuard)` nos controllers daqui.
  - Rotas: `GET /platform/me` → `{ roles, permissions }` (exige ter qualquer papel; senão 404); `GET /platform/staff` (`platform.roles.manage`, cursor por user id: `userId`, `name`, `email`, `roles`); `PUT /platform/staff/:userId/roles/:roleKey` e `DELETE ...` (`platform.roles.manage`, corpo `{ currentAuthProof }`, `@ThrottleReauth()`, 204, idempotentes). Retirar `platform_admin` do último admin vivo → 422 `last-platform-admin` (sob `lockAdmins`). `roleKey` inválido → 422; usuário inexistente → 404.
  - Script: `node scripts/platform-grant-admin.ts <email>` (TypeScript apagável, Node 24, só `pg` + `process.loadEnvFile`, sem imports do projeto), conecta como `DB_USERNAME`; idempotente; grava `platform.role.granted` em `platform_audit_logs` com `user_id` NULL e `metadata { via: 'cli' }`; e-mail inexistente → sai com código 1 e mensagem. Exporta `grantPlatformAdmin(client, email)` para o e2e.
- [ ] **Step 1: Testes que falham**
  - unit `platform-access.spec.ts`: sem permissão → `NotFoundError`; com → devolve as permissões.
  - unit revoke: último admin → `last-platform-admin`; com dois admins → ok e audita.
  - e2e `staff.e2e-spec.ts`: usuário comum em `GET /platform/me` → 404; admin (via script `grantPlatformAdmin` no banco de teste) → 200 com as 5 permissões; admin dá `platform_support` a outro → `GET /platform/me` dele 200 com 2 permissões; retirar → a próxima chamada dele dá 404 (Review Focus 3); suporte em `GET /platform/staff` → 404; retirar o próprio `platform_admin` sendo o único → 422 `last-platform-admin`; duas retiradas concorrentes dos dois únicos admins → uma 204, outra 422 (Review Focus 4); `currentAuthProof` errada → 422 `current-auth-proof-invalid`; `platform_audit_logs` tem as linhas; o JSON de `GET /me` de cliente não tem chave contendo `platform`.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** verificação completa (host + container) → verde.
- [ ] **Step 5: Commit** `feat(platform): staff access, roles and platform audit`.

### Task 3: Operações administrativas exportadas por `hubs`, `organizations` e `identity`

**Files:**
- Create: `src/shared/application/audit-actor.ts` (+ spec)
- Modify: `src/hubs/application/deregister-hub.use-case.ts` → extrair o núcleo para `src/hubs/application/hub-administration.ts` (`HubAdministration`, exportado pelo `HubsModule`); `src/spaces/application/space-room.service.ts` (`BulkRoomRevocation` ganha `auditMetadata?`); `src/organizations/application/organization-administration.ts` (`OrganizationAdministration`, exportado); `src/identity/application/user-directory.ts` (`findPublicByEmail`)
- Test: specs unitários ao lado; `test/hubs/administration.e2e-spec.ts`, `test/organizations/administration.e2e-spec.ts`

**Interfaces:**
- Produces:
  - `type AuditActor = { kind: 'user'; userId: string } | { kind: 'platform'; supportRequestId: string }`; `auditActorFields(a: AuditActor): { userId: string | null; metadata: Record<string, unknown> }` (`platform` → `{ userId: null, metadata: { actor: 'platform', supportRequestId } }`).
  - `HubAdministration.deregister(hubId: string, actor: AuditActor): Promise<void>` — o mesmo efeito, ordem de locks e auditoria do desregistro do dono, com `auditActorFields` em **toda** gravação (`hub.organization.revoked`, `hub.deregistered`, `hub.room.revoked` via `auditMetadata`/`actorId: null`). Para `platform`: descobre o dono lendo o Hub no contexto `{ hubId }` (`uow.withContext`) e roda o resto no contexto `{ userId: dono }`, como hoje. Hub inexistente/desregistrado → `hubNotFound()`. `DeregisterHubUseCase` passa a ser: `requireOwner` + `HubAdministration.deregister(hubId, { kind: 'user', userId })`.
  - `HubAdministration.summary(hubId): Promise<{ hubId, name, ownerUserId, deregistered: boolean, organizationIds: string[] } | null>` (só leitura, no contexto do Hub; nada cifrado nem chave).
  - `OrganizationAdministration.appointAdmin(orgId, userId, actor: AuditActor, now): Promise<{ joined: boolean }>` — organização pessoal → `DomainValidationError('personal-organization-protected')`; inexistente → `NotFoundError('organization-not-found')`; usuário inexistente → `NotFoundError('user-not-found')`; não membro: `SeatPolicy`, `memberships.add`, `member.joined`; depois `assignOrgRole(..., 'org_admin', ...)` + `member.role_changed` (sem gravar se já é admin); tudo no contexto `{ organizationId }`, com `roles.lockOrgAdmins` antes (mesma ordem de locks do módulo).
  - `OrganizationAdministration.summary(orgId)`: `{ organizationId, name, personal: boolean, adminUserIds, memberCount } | null`.
  - `UserDirectory.findPublicByEmail(email): Promise<PublicUser | null>` (normaliza como o login).
- [ ] **Step 1: Testes que falham**
  - unit `audit-actor.spec.ts` (as duas formas).
  - e2e hubs: desregistro pela administração com ator `platform` produz **o mesmo estado** que o do dono (reaproveitar os helpers de `test/support/hubs-kit.ts`: vínculos revogados, espaços fora, Sala caída com `keyRotationRequired`, papéis com lápide, token do Hub recusado) e toda linha nova de `audit_logs` tem `user_id` NULL e `metadata.actor = 'platform'`; Hub já desregistrado → `hub-not-found`; o e2e do desregistro pelo dono continua verde (sem regressão).
  - e2e organizations: nomear membro atual → vira `org_admin`, `member.role_changed` com ator plataforma; nomear não membro → `member.joined` + admin; organização pessoal → 422 `personal-organization-protected`; repetir → sem nova linha de auditoria.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** Implementar (refatorar sem mudar o comportamento do desregistro pelo dono).
- [ ] **Step 4:** verificação completa → verde.
- [ ] **Step 5: Commit** `feat(platform): administrative operations in hubs and organizations`.

### Task 4: Pedidos de suporte

**Files:**
- Create: `src/platform/domain/support-request.ts` (+ spec), `support-request.repository.ts`; `src/platform/application/create-support-request.use-case.ts`, `decide-support-request.use-case.ts` (aprovar/recusar), `list-support-requests.use-case.ts`, `get-support-request.use-case.ts`, `support-request-executor.ts` (+ specs); `src/platform/infra/db/support-request.*`; `src/platform/infra/http/support-requests.controller.ts`, `dto/`
- Test: `test/platform/support-requests.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 2 (`PlatformAccess`, `PlatformAudit`, `PlatformRoleRepository.hasAnyRole`), Task 3 (`HubAdministration.deregister`, `OrganizationAdministration.appointAdmin`, `AuditActor`), `CurrentAuthProofVerifier`.
- Produces:
  - Domínio `SupportRequest`: `create({ type, target, reason, evidence, requestedBy, now })` (valida tipo × alvo e tamanhos; `expiresAt = now + 7 dias`), `approve(deciderId, now)` (`self-approval` 422 se decider == requester; `support-request-expired` 422 se `now >= expiresAt`, deixando estado `expired`; `support-request-not-pending` 409 se não pendente), `reject(deciderId, note, now)` (mesmas regras), `markExecuted(now)`, `markFailed(type, now)`.
  - `SupportRequestExecutor.execute(request, now)`: dentro de um `uow.run` **aninhado** (savepoint); `hub_force_deregister` → `HubAdministration.deregister(targetHubId, { kind: 'platform', supportRequestId })`; `org_appoint_admin` → confere `hasAnyRole(targetUserId)` (`staff-cannot-be-appointed` → falha) e chama `appointAdmin`. Erro de domínio (`DomainError` e subclasses) → `markFailed(type)` e `platform.request.failed`; qualquer outro erro sobe.
  - Rotas (`@RequirePlatformPermission`, `@ThrottleReauth()` e `currentAuthProof` nas mutações):
    - `POST /platform/support-requests` (`platform.support.request`): corpo `{ type, hubId? , organizationId?, userId?, reason, evidence, currentAuthProof }`. Na criação: nomeação com alvo que tem papel da plataforma → 422 `staff-cannot-be-appointed`. Quem tem `platform.support.execute_alone` → cria já aprovado (decider = ele) e executa na mesma transação; senão `pending`. Resposta 201 com o pedido (estado final).
    - `POST /platform/support-requests/:id/approve` (`platform.support.approve`) → aprova e executa; `.../reject` com `{ note, currentAuthProof }`. Resposta 200 com o pedido.
    - `GET /platform/support-requests` (`platform.audit.read`; `?status=`; cursor por id; quem não tem `platform.support.approve` vê só os próprios) e `GET /platform/support-requests/:id` (mesma regra; de outro → 404).
  - Vencimento: na leitura e na decisão, pendente com `expiresAt <= now` vira `expired` (gravado) com `platform.request.expired`.
  - Auditoria: `platform.request.created|approved|rejected|executed|failed|expired` em `platform_audit_logs` com `support_request_id` e alvos.
- [ ] **Step 1: Testes que falham**
  - unit domínio: tipo × alvo inválido; `reason` vazio/2001 chars; self-approval; expirado; não pendente; reject exige nota (1..2000).
  - unit executor: erro de domínio vira `failed` sem propagar; erro genérico propaga.
  - e2e (com `platform-kit` e `hubs-kit`): suporte pede desregistro → `pending`, Hub intacto; o próprio suporte aprova → 422 `self-approval`; admin aprova → `executed` e Hub desregistrado (token do Hub 401); admin pede direto → `executed` na resposta do POST; pedido de Hub já desregistrado → 200/201 com `failed` e `failureType` `hub-not-found` (Review Focus 2); nomeação: suporte pede, admin aprova → alvo vira `org_admin` e o `audit_logs` da organização tem `user_id` NULL e `supportRequestId`; alvo com papel da plataforma na criação → 422; alvo que ganha papel depois do pedido → aprovação dá `failed` com `staff-cannot-be-appointed` (Review Focus 1); organização pessoal → `failed` `personal-organization-protected`; pedido com 8 dias (ajustar `expires_at` no banco) → aprovação 422 `support-request-expired` e estado `expired` (Review Focus 5); suporte lista e vê só os próprios; financeiro → 404 em todas as rotas; recusa com nota → `rejected`, nada muda.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** verificação completa → verde.
- [ ] **Step 5: Commit** `feat(platform): support requests with two-person approval`.

### Task 5: Consultas do suporte e leitura da auditoria da plataforma

**Files:**
- Create: `src/platform/application/lookup.use-cases.ts` (conta por e-mail, Hub, organização) (+ spec), `list-platform-audit.use-case.ts`; `src/platform/infra/http/platform-lookup.controller.ts`, `platform-audit.controller.ts`, `dto/`
- Test: `test/platform/lookup.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 3 (`UserDirectory.findPublicByEmail`, `HubAdministration.summary`, `OrganizationAdministration.summary`), Task 2 (`PlatformAccess`).
- Produces (todas `platform.support.request` ou `platform.support.approve`; `platform.audit.read` na auditoria):
  - `GET /platform/lookup/users?email=` → `{ userId, name, email }` (sem `publicKey`) ou 404.
  - `GET /platform/lookup/hubs/:hubId` → summary do Hub ou 404 (`uuidPipe`).
  - `GET /platform/lookup/organizations/:orgId` → summary da organização ou 404.
  - `GET /platform/audit` → cursor por id (mais recente primeiro), filtros opcionais `?supportRequestId=`. Quem não
    tem `platform.support.approve` vê só as linhas dos próprios pedidos (mesma regra da lista de pedidos, spec §4.1).
- [ ] **Step 1: Testes que falham** — e2e: suporte acha conta por e-mail (com maiúsculas), Hub e organização; respostas sem nenhuma chave contendo `key`, `wrapped`, `encrypted` ou `publicKey` (busca recursiva, helper de `test/support/json-keys.ts`); usuário comum e financeiro → 404; auditoria lista as ações das tasks anteriores para o admin.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** verificação completa → verde.
- [ ] **Step 5: Commit** `feat(platform): support lookups and platform audit listing`.

### Task 6: Documentação viva e fechamento

**Files:**
- Modify: `CLAUDE.md` (seção nova `## Módulo platform`: papéis, permissões, fronteira, `AuditActor`, operações administrativas exportadas, pedidos e estados, regras de alvo, 404 sem papel, comando do primeiro admin; rate limit: as rotas que entram no `reauth`; "Pendências": quarentena/e-mail, leitura da auditoria pelo cliente, endurecer aprovação dupla), `docs/hubs/hub-lifecycle.md` (desregistro forçado pela plataforma como saída para Hub preso), spec (status implementada)
- [ ] **Step 1:** Atualizar os docs.
- [ ] **Step 2:** Verificação completa (host + container: `migration:show`, `schema:check`, `test:e2e`).
- [ ] **Step 3: Commit** `docs: document platform module`, push e conferir o CI da `develop`.
