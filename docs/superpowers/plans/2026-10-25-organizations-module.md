# Módulo `organizations` — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Organizações, organização pessoal no cadastro, membros por convite com link, papéis de fábrica (RBAC),
kit de recuperação substituível, auditoria e contagem de assentos.

**Architecture:** É um módulo novo, `src/organizations/`, com as camadas `domain` / `application` / `infra`, no
padrão do `identity`.
- **Dependência num sentido só:** o `organizations` importa o `identity`, que exporta da `application/` um
  `UserDirectory` (dados públicos de usuários) e um `CurrentAuthProofVerifier` (reautenticação).
- **Cadastro sem ciclo de módulos:** o `identity` chama um registro global de ganchos de cadastro
  (`RegistrationHooks`, em `shared`), e o `organizations` se inscreve nele.
- **Unit of work:** um unit of work em `shared` (AsyncLocalStorage + `EntityManager`) põe cadastro, organização
  pessoal e aceite de convite numa transação só. O mesmo mecanismo carrega o contexto de RLS
  (`app.organization_id` e `app.user_id`).

**Tech Stack:** NestJS 12, TypeORM 1, PostgreSQL 18 (RLS), Vitest, `libsodium-wrappers-sumo`, `node:async_hooks`.

**Spec:** `docs/superpowers/specs/2026-10-25-organizations-design.md` (aprovada em 25/10/2026). Contexto:
`CLAUDE.md`, `docs/der_model.sql`,
`../valter-valt-ai/docs/superpowers/specs/2026-10-24-organizacoes-espacos-e-nuvem-design.md` §3, §4.1, §5, §7.2.

## Decisões deste plano (o builder fica com elas)
1. **Unit of work** (`src/shared/infra/db/unit-of-work.ts`):
   - `UnitOfWork.run(work)` abre uma transação e guarda o `EntityManager` num `AsyncLocalStorage`. Um `run`
     aninhado reutiliza a transação existente.
   - `currentManager(dataSource)` devolve o manager da transação ativa ou o `dataSource.manager`.
   - **Todo** repositório TypeORM (os do `identity` também) usa `currentManager` em vez de `@InjectRepository`
     direto.
   - `UnitOfWork.setContext({ organizationId?, userId? })` grava `set_config('app.organization_id'|'app.user_id', $1, true)`
     na transação ativa. `runInOrganizationScope` passa a ser um `run` com `setContext`.
2. **RLS:**
   - tabelas com `organization_id` usam `enableOrganizationRls`;
   - `user_organization` ganha uma segunda policy só de leitura: `user_id = NULLIF(current_setting('app.user_id', true), '')::uuid`,
     para "minhas organizações";
   - `organizations` usa a policy `id = app.organization_id OR app_is_member(id)`. `app_is_member(org uuid)` é uma
     função `SECURITY DEFINER STABLE` que consulta `user_organization` ativa com o `app.user_id`;
   - o catálogo (`permissions`, `permission_dependency`, `role_permission`) não tem RLS. `roles` tem policy
     `organization_id IS NULL OR organization_id = app.organization_id`;
   - convite por token: a função `SECURITY DEFINER` `app_find_invitation(token_hash text)` devolve
     `id, organization_id` do convite, para a prévia e o aceite descobrirem a organização antes de ter contexto.
3. **Ganchos de cadastro** (`src/shared/application/registration-hooks.ts`):
   - classe global com `register(hook)` e `run(ctx): Promise<RegistrationHookResult>`;
   - `ctx = { userId, name, email, inviteToken?: string, now: Date }`;
   - o resultado tem o formato `{ invitation?: { accepted: boolean } }`;
   - `RegisterUserUseCase` roda tudo dentro de `UnitOfWork.run` e chama `hooks.run` depois de criar o usuário e
     antes de abrir a sessão;
   - se um gancho lançar erro, o cadastro inteiro é desfeito.
4. **O `identity` exporta** (`application/`):
   - `UserDirectory.findPublicByIds(ids): Promise<PublicUser[]>`, com
     `PublicUser = { id, name, email, publicKey }`;
   - `CurrentAuthProofVerifier.verify(userId, currentAuthProof): Promise<void>`. Prova malformada ou errada lança
     `DomainValidationError('current-auth-proof-invalid')`. Ela reutiliza o hasher e o padrão de tempo uniforme
     do `ChangePasswordUseCase`, que passa a usar o verificador.
5. **Convite:**
   - segredo de 32 bytes em base64url;
   - o link é `<sem host>?token=<segredo>`: o backend devolve só o `token`, e o app monta o link;
   - `token_hash` = hex de `crypto_generichash(32, bytes)`;
   - validade de 7 dias (`INVITATION_TTL_DAYS = 7`, constante de domínio) e uso único;
   - o aceite é um `UPDATE ... WHERE id AND status='pending' AND expires_at > now()`, atômico;
   - erro único para qualquer convite que não vale: `DomainValidationError('invitation-invalid')` (422) nas rotas
     do convite. No cadastro, o resultado é `accepted: false`.
6. **Assentos:**
   - `SeatPolicy` no domínio: `seatLimit(plan: string): number | null`, com `null` = ilimitado; todo plano por
     enquanto;
   - assento = membro ativo; convite pendente não conta;
   - estourou, lança `ConflictError('seat-limit-reached')` (409);
   - é conferido ao criar e ao aceitar um convite.
7. **Permissões na borda:**
   - `OrganizationAccess` (application, exportado) com dois métodos:
     - `requireMember(orgId, userId)`: quem não é membro recebe `NotFoundError('organization-not-found')` (404);
     - `requirePermission(orgId, userId, permission)`: o membro sem a permissão recebe
       `PermissionDeniedError('permission-denied')` (403);
   - a checagem resolve `role_assignments` (escopo `organization`) e `role_permission`.
8. **Kit de recuperação:**
   - `PUT /organizations/:id/recovery-key` recebe `{ recoveryPublicKey, currentAuthProof }`;
   - valida o formato com `assertPublicKey` do domínio do `identity`, copiando a regra para o domínio de
     `organizations` (sem importar domínio de outro módulo): X25519 de 32 bytes, base64url sem padding;
   - grava a auditoria `organization.recovery_key.replaced`, ou `.registered` na primeira vez.
9. **Auditoria:**
   - `AuditLog.record({ organizationId, userId, action, metadata? })`, exportado;
   - ações desta etapa: `organization.created`, `organization.updated`, `organization.recovery_key.registered`,
     `organization.recovery_key.replaced`, `member.joined`, `member.left`, `member.removed`, `member.role_changed`,
     `invitation.created`, `invitation.revoked`;
   - `result` vale sempre `success`;
   - `metadata` nunca leva segredo (o token não entra).
10. **Rate limits novos** (em `rate-limits.ts`): `invitationPreview` 30/min por IP e `invitationAccept` 10/min por IP.

## Global Constraints
- **Código:** ESM com `.js` nos imports relativos, Vitest, oxlint sem avisos e Prettier.
- **Camadas:** `domain/` puro. Um módulo nunca importa a `infra/` de outro, nem o `domain/` de outro; só o que o
  outro exporta da `application/`.
- **Contratos:** classes abstratas como tokens de DI, `{ provide: X, useClass: Y }`, sem `useFactory` para casos
  de uso.
- **API:** JSON em `camelCase`, datas ISO UTC, paginação por cursor (`CursorPaginationQuery`), erros
  `problem+json` com `type` estável. Validação de formato no DTO, regra de negócio no domínio.
- **Banco:** UUID v7; toda tabela com `created_at`/`updated_at`/`deleted_at`; remover é lápide; sincronizáveis
  com `sync_version` (trigger). Migrations com `down`, e os metadados das entidades descrevem tudo
  (`migration:generate` vazio). RLS testado pelo papel de runtime (`vaulter_app`), nunca pelo dono.
- **Nome e segredos:** o nome do produto nunca entra em código. Segredos nunca vão para log, Sentry ou resposta,
  com uma exceção: o `token` do convite vai **uma vez**, na criação.
- **Fluxo:** commits pequenos (Conventional Commits) direto na `develop`, com push a cada commit. Antes de dar
  por pronto: `npm run build && npm test && npm run lint`, `npm run test:e2e` no container e CI verde. Os e2e
  rodam com `docker exec vaulter-back-app npx vitest run --config vitest.config.e2e.ts <arquivo>`.

## Review Focus
1. **Não membro:** um usuário que não é membro não vê nada da organização (detalhe, membros, convites), nem por
   HTTP (404) nem por SQL direto com o papel de runtime (RLS). (Tasks 5 e 9)
2. **Cadastro com convite:**
   - uma falha no meio desfaz tudo, sem deixar usuário sem organização pessoal nem vínculo sem usuário;
   - um convite inválido não impede o cadastro. (Task 8)
3. **Aceites concorrentes do mesmo convite:** só um vence, porque o convite é de uso único. (Tasks 5 e 9)
4. **Último administrador e dono da pessoal:** não dá para remover, rebaixar ou fazer sair o último
   administrador, nem tirar o dono da própria organização pessoal, inclusive com duas requisições concorrentes.
   (Tasks 4, 7 e 9)
5. **Troca do kit:** exige reautenticação, é auditada e o `metadata` não carrega segredo. A prévia pública do
   convite não expõe e-mail. (Tasks 7 e 9)

---

### Task 1: Unit of work, contexto de RLS e repositórios transacionais
**Files:**
- Create: `src/shared/infra/db/unit-of-work.ts` (+ spec de integração em `test/shared/unit-of-work.e2e-spec.ts`).
- Modify: `src/shared/infra/db/organization-scope.ts`, `src/identity/infra/db/{user,user-session}.typeorm-repository.ts`,
  `src/database/database.module.ts` (provider global do `UnitOfWork`) e `CLAUDE.md` (padrão de repositório).

**Interfaces (Produces):**
- `class UnitOfWork { run<T>(work: () => Promise<T>): Promise<T>; setContext(ctx: { organizationId?: string; userId?: string }): Promise<void> }`;
- `currentManager(dataSource: DataSource): EntityManager`;
- `runInOrganizationScope` mantém a assinatura.

- [ ] Testes que falham:
  - dentro de `run`, dois repositórios do `identity` gravam e um erro lançado no fim desfaz os dois;
  - um `run` aninhado reutiliza a mesma transação (`txid_current()` igual);
  - `setContext` fora de `run` lança erro;
  - `setContext({ organizationId })` faz o RLS do `rls_probe` filtrar, pelo papel de runtime;
  - fora de `run`, os repositórios funcionam como antes (suite atual verde).
- [ ] Implementar, refatorar os repositórios e os testes RLS existentes, e commitar
  `feat(shared): unit of work with RLS context`.

### Task 2: DER (`.sql` e `.mwb`)
**Files:** `docs/der_model.sql` e `docs/der_model.mwb`.
- [ ] No `.sql`:
  - `organizations.recovery_public_key` passa a `NULL` (comentário: "nulo até o primeiro espaço ou ação
    explícita");
  - nova coluna `personal_owner_user_id CHAR(36) NULL` com FK para `users`, índice único
    `uq_organizations_personal_owner` e comentário;
  - nova tabela `organization_invitations` (colunas da spec §4, FKs para `organizations`, `roles` e `users`,
    índice único `uq_organization_invitations_token_hash`, comentário de não sincronizável).
- [ ] No `.mwb`: as mesmas mudanças, editando o XML como no Task 7 do plano do `identity`, com ids novos únicos e
  figura sem sobreposição. Validar parse, referências e abertura no `mysql-workbench-community` sem interface.
- [ ] Commitar `docs: organizations changes in data model`.

### Task 3: Catálogo RBAC (permissões e papéis de fábrica)
**Files:**
- Create: migration `CreateRbacCatalog`;
- Create: entidades `src/organizations/infra/db/{permission,permission-dependency,role,role-permission}.entity.ts`;
- Create: `src/organizations/domain/rbac-catalog.ts` (as chaves de permissões e papéis como constantes tipadas);
- Create: `test/organizations/rbac-catalog.e2e-spec.ts`;
- Create: o esqueleto de `src/organizations/organizations.module.ts`, importado no `AppModule`.

**Interfaces:** `PERMISSIONS` (const com as 16 chaves da spec §4.1, cada uma com escopo), `FACTORY_ROLES` (const
com a tabela da spec §6), `type PermissionKey` e `type FactoryRoleKey`.
- [ ] Testes:
  - depois da migration, o banco tem exatamente as permissões e os papéis de fábrica da spec §6, com
    `organization_id` nulo e `role_permission` igual à tabela;
  - as dependências são `camera.live → camera.view` e `nodes.control → nodes.view`;
  - as tabelas sincronizáveis têm `sync_version`;
  - o `migration:generate` sai vazio.
- [ ] A migration insere os dados com ids fixos (UUID v7 gerados uma vez e gravados na migration) e tem `down`.
  Commitar `feat(organizations): RBAC catalog with factory roles`.

### Task 4: Domínio
**Files:**
- `src/organizations/domain/{organization,membership,invitation,seat-policy,recovery-key}.ts`, com specs;
- os contratos de repositório (classes abstratas em `domain/*.repository.ts`), com as interfaces listadas na Task 5.

**Interfaces:**
- `Organization`:
  - `create({ name, ownerId, now })`;
  - `createPersonal({ name, ownerId, now })`;
  - `restore`;
  - `rename(name)` (1–255 caracteres, com trim);
  - `setHubLinkPolicy(p)`;
  - `setRecoveryKey(publicKey): 'registered' | 'replaced'`;
  - getters: `isPersonal`, `personalOwnerUserId`, `plan`, `recoveryPublicKey`, `hubLinkPolicy`.
- `assertRecoveryPublicKey(s)`: 32 bytes em base64url estrito, com código `recovery-public-key-invalid`.
- `Invitation`:
  - `issue({ organizationId, roleKey, email?, createdBy, now }) → { invitation, token }` (o token só existe aqui);
  - `canBeAcceptedBy(email, now)`;
  - `hashToken(token)`.
- `MembershipRules`:
  - `assertCanRemove(target, { isLastAdmin, isPersonalOwner })`;
  - `assertCanChangeRole(...)`;
  - `assertCanLeave(...)`;
  - códigos de erro: `last-admin`, `personal-owner-protected`, `cannot-leave-personal`.
- `SeatPolicy.seatLimit(plan)` e `assertSeatAvailable(activeCount, plan)`.

- [ ] Testes unitários de cada regra: limites de nome, kit registrado e depois substituído, convite expirado, e-mail
  diferente (normalizado), token nunca exposto pelo getter, último admin, dono da pessoal protegido e assento.
- [ ] Commitar `feat(organizations): organization, membership and invitation domain`.

### Task 5: Tabelas de organização, RLS e repositórios
**Files:**
- Create: migration `CreateOrganizations` com `organizations`, `user_organization`, `role_assignments` (completa
  como no DER, colunas futuras nulas e sem FK para tabelas inexistentes), `organization_invitations`,
  `audit_logs` (completa, mesmo tratamento), as funções `app_is_member` e `app_find_invitation`, as policies e o
  `addSyncVersionTrigger` nas sincronizáveis;
- Create: as entidades, os mappers e os repositórios em `src/organizations/infra/db/`;
- Create: `test/organizations/repositories.e2e-spec.ts`.

**Interfaces** (implementam os contratos criados na Task 4, em `src/organizations/domain/*.repository.ts`):
- `OrganizationRepository`: `create`, `save`, `findById(orgId)`, `listForUser(userId, page)` → `CursorPage<OrganizationWithRole>`;
- `MembershipRepository`:
  - `add` (limpa a lápide se existir);
  - `remove` (lápide);
  - `find(orgId, userId)`;
  - `list(orgId, page)`;
  - `countActive(orgId)`;
  - `countAdmins(orgId)`;
- `RoleAssignmentRepository`: `assignOrgRole(orgId, userId, roleKey, grantedBy)`, `orgRoleOf(orgId, userId)`,
  `permissionsOf(orgId, userId)`;
- `InvitationRepository`:
  - `create`;
  - `findByTokenHash(hash)` (pela função `SECURITY DEFINER`);
  - `listPending(orgId, page)`;
  - `revoke(orgId, id)`;
  - `markAccepted(id, userId, now): Promise<boolean>` (condicional);
- `AuditLogRepository`: `append(entry)`.

Todos rodam no unit of work e com o contexto de RLS (Task 1).
- [ ] Testes, sempre pelo papel de runtime:
  - um não membro não lê `organizations` nem `user_organization` de outra organização, nem com SQL direto;
  - `listForUser` traz só as minhas organizações, com o meu papel;
  - `markAccepted` concorrente: `[true, false]`;
  - um convite expirado ou revogado não é aceito;
  - o índice único impede duas organizações pessoais para o mesmo dono;
  - lápide e reentrada em `user_organization` reaproveitam a linha;
  - `audit_logs` só aceita acréscimo;
  - `migration:generate` vazio e `migration:revert` + `run` funcionam.
- [ ] Commitar `feat(organizations): organization tables with row-level security`.

### Task 6: `identity` exporta `UserDirectory`, `CurrentAuthProofVerifier` e os ganchos de cadastro
**Files:**
- `src/identity/application/{user-directory,current-auth-proof-verifier}.ts`, com specs;
- `src/identity/identity.module.ts` (os `exports`);
- `src/shared/application/registration-hooks.ts`, com spec;
- `src/identity/application/register-user.use-case.ts`, com spec;
- `src/identity/infra/http/dto/register.dto.ts` e `login-response.dto.ts` (`inviteToken` opcional, resposta com
  `invitation?`);
- `src/identity/application/change-password.use-case.ts`, que passa a usar o verificador.

**Interfaces:** as da decisão 3 e da decisão 4.
- [ ] Testes:
  - `RegisterUserUseCase` chama `hooks.run` dentro do unit of work, com o `inviteToken` repassado;
  - um gancho que lança desfaz o usuário (e2e no Task 8);
  - o resultado dos ganchos aparece em `LoginResult.invitation`;
  - `CurrentAuthProofVerifier` dá `current-auth-proof-invalid` para prova errada e para prova malformada, com
    `verifyAgainstDummy`;
  - a suite atual continua verde.
- [ ] Commitar `feat(identity): registration hooks, user directory and reauthentication`.

### Task 7: Casos de uso do `organizations`
**Files:** `src/organizations/application/*.use-case.ts`, `organization-access.ts`, `audit-log.ts`,
`personal-organization.registration-hook.ts`, os DTOs de saída e as specs.

**Interfaces:**

| Caso de uso | O que faz |
|---|---|
| `CreateOrganizationUseCase.execute(actor, { name })` | cria a organização, põe o autor como membro com `org_admin` e audita |
| `ListMyOrganizationsUseCase.execute(actor, page)` | lista as organizações do autor |
| `GetOrganizationUseCase.execute(actor, orgId)` | precisa ser membro |
| `UpdateOrganizationUseCase.execute(actor, orgId, { name?, hubLinkPolicy? })` | precisa de `org.members.manage` e audita |
| `SetRecoveryKeyUseCase.execute(actor, orgId, { recoveryPublicKey, currentAuthProof })` | verifica a prova, valida, grava e audita `registered`/`replaced` |
| `ListMembersUseCase.execute(actor, orgId, page)` | membro; junta com `UserDirectory`: nome, e-mail, `publicKey`, papel e `joinedAt` |
| `ChangeMemberRoleUseCase.execute(actor, orgId, userId, roleKey)` | aceita só `org_admin` ou `org_member` e aplica as regras |
| `RemoveMemberUseCase` | aplica as regras |
| `LeaveOrganizationUseCase` | aplica as regras |
| `CreateInvitationUseCase.execute(actor, orgId, { roleKey, email? }) → { invitation, token }` | precisa de admin e confere assento |
| `ListInvitationsUseCase` | lista os convites pendentes |
| `RevokeInvitationUseCase` | revoga |
| `PreviewInvitationUseCase.execute(token) → { organizationName, invitedByName, expiresAt }` | não expõe e-mail |
| `AcceptInvitationUseCase.execute(actor, token)` | exportado |
| `PersonalOrganizationRegistrationHook` | inscrito no `RegistrationHooks` no `onModuleInit` |

Regras do aceite:
- confere e-mail, validade e assento;
- `markAccepted` atômico;
- adiciona o membro com o papel do convite;
- audita `member.joined`;
- se já for membro, o convite é consumido sem duplicar.

O gancho de cadastro cria a organização pessoal (com `personal_owner_user_id`) e, se houver `inviteToken`, tenta o
aceite. Um convite inválido dá `accepted: false` e não lança erro.

Regras do último administrador e do dono da pessoal sob concorrência: as contagens e a mudança rodam no mesmo unit
of work, travando as atribuições de admin da organização (`SELECT ... FOR UPDATE`), para duas remoções
simultâneas não esvaziarem a organização.
- [ ] Testes unitários de cada caso de uso com mocks: 404 para não membro, 403 para membro sem permissão, auditoria
  com a ação certa, token nunca em log ou auditoria, as regras do aceite e o gancho de cadastro.
- [ ] Commitar `feat(organizations): use cases for organizations, members and invitations`.

### Task 8: Cadastro com organização pessoal e convite (integração)
**Files:** `test/organizations/registration.e2e-spec.ts` e ajustes em `test/identity/auth.e2e-spec.ts` ou nos
helpers.
- [ ] e2e:
  - cadastro sem convite: a resposta igual à atual mais `invitation` ausente; o banco tem a organização pessoal
    com `is_personal`, o dono e o usuário como `org_admin`;
  - cadastro com convite válido: vínculo criado com o papel do convite e `invitation.accepted = true`;
  - cadastro com convite inválido (expirado, revogado, usado ou de outro e-mail): conta e organização pessoal
    criadas e `accepted = false`;
  - falha forçada no gancho (por exemplo, sobrescrevendo o provider): nenhuma linha em `users`,
    `organizations` ou `user_organization`.
- [ ] Commitar `test(organizations): registration creates the personal organization atomically`.

### Task 9: HTTP
**Files:**
- `src/organizations/infra/http/{organizations,members,invitations}.controller.ts` e os DTOs;
- `rate-limits.ts`;
- `test/organizations/{organizations,members,invitations}.e2e-spec.ts`;
- `test/support/identity-client.ts`, ganhando um helper para criar uma organização.

As rotas são as da spec §7. Todas são internas (sem `public`), com `@ApiTags('organizations')`.
- [ ] e2e:
  - o CRUD básico;
  - um não membro recebe 404 em todas as rotas `/organizations/:id/*`;
  - um membro comum recebe 403 nas ações de admin;
  - o fluxo de convite (criar, prévia sem e-mail, aceitar logado, consumido) e dois aceites concorrentes (um 200,
    um 422);
  - convite revogado e expirado dão 422 `invitation-invalid`;
  - o último admin não pode sair nem ser rebaixado (422);
  - o dono da pessoal é protegido;
  - o kit: sem prova ou com prova errada dá 422; com prova certa dá 204 e grava a auditoria
    (`registered` depois `replaced`);
  - a lista de membros traz `publicKey` e não traz `authHash`;
  - os rate limits da prévia e do aceite;
  - o Swagger público continua sem estas rotas.
- [ ] Commitar `feat(organizations): organizations, members and invitations endpoints`.

### Task 10: Documentação e verificação final
- [ ] `CLAUDE.md`:
  - o módulo `organizations` e o mapa de dependências entre módulos;
  - o unit of work e o contexto de RLS (`app.user_id`, as funções `SECURITY DEFINER`);
  - os ganchos de cadastro;
  - o padrão `OrganizationAccess` para os próximos módulos;
  - os rate limits novos;
  - a auditoria.
- [ ] A verificação completa e o CI verde. Commitar `docs: document organizations module`.
