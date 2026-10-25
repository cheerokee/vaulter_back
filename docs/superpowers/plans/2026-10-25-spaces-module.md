# Módulo `spaces` — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Espaços cifrados de uma organização: criar, membros com papel, cópias trancadas da chave por versão,
troca de chave na saída, retrancamento para kit novo, reabertura de espaço órfão pelo kit e convite que indica
espaços.

**Architecture:** É um módulo novo, `src/spaces/`, com as camadas `domain` / `application` / `infra`.
- **Dependências num sentido só:** `spaces` → `organizations` (`OrganizationAccess`, `AuditLog`, o kit atual da
  organização e a checagem de membro ativo) e `spaces` → `identity` (`UserDirectory`,
  `CurrentAuthProofVerifier`).
- **O `organizations` não conhece o `spaces`:** chama dois registros globais de ganchos em
  `src/shared/application/`, no padrão do `RegistrationHooks`:
  - `MemberRemovedHooks`: membro saiu ou foi removido da organização;
  - `InvitationHooks`: validar espaços indicados num convite e reagir ao aceite.
- **Persistência e acesso:** tudo roda no unit of work com RLS por organização. O `SpaceAccess` (exportado) faz
  para o espaço o que o `OrganizationAccess` faz para a organização.

**Tech Stack:** NestJS 12, TypeORM 1, PostgreSQL 18 (RLS), Vitest, `libsodium-wrappers-sumo`.

**Spec:** `docs/superpowers/specs/2026-10-25-spaces-design.md` (aprovada em 25/10/2026). Contexto: `CLAUDE.md`
("Módulo organizations", unit of work, RLS), `docs/crypto/user-keys.md`, `docs/der_model.sql`.

## Decisões deste plano
1. **Cópia trancada (formato v1):**
   - `0x01 ‖ crypto_box_seal(spaceKey32, recipientX25519PublicKey)`, ou seja, 81 bytes em base64url sem padding;
   - validação no domínio: `assertWrappedSpaceKey(s)`, com 81 bytes exatos e `[0] === 0x01`, código
     `wrapped-key-invalid`;
   - vetor de teste no `docs/crypto/user-keys.md`; o selo é aleatório, então o vetor prova a abertura, não os
     bytes.
2. **Impressão do kit:** `recovery_key_fingerprint` = hex de `crypto_generichash(32, recoveryPublicKeyBytes)`.
   - Toda operação que grava uma `recovery_wrapped_key` (criar, trocar a chave, retrancar) recebe
     `recoveryPublicKey` do app e confere que é igual à da organização. Senão: `ConflictError('recovery-key-changed')`.
   - A impressão vem da chave atual da organização, nunca do cliente.
   - "Retrancar pendente" é calculado: existe versão cuja impressão difere da do kit atual.
3. **Tabelas novas e colunas:**
   - `spaces.key_rotation_required boolean default false`;
   - `space_keys.recovery_key_fingerprint varchar(64) not null`;
   - `space_pending_grants`: `id`, `organization_id`, `space_id`, `user_id`, `role_id`, `invitation_id`,
     `requested_by_user_id`, `status` (`pending` | `granted` | `declined` | `cancelled`) e os timestamps; não
     sincroniza;
   - `invitation_space_intents`: `id`, `organization_id`, `invitation_id`, `space_id`, `role_id` e os
     timestamps; não sincroniza.
   - Todas com `organization_id` e RLS por organização.
   - `space_keys` e `space_key_grants` **ganham `organization_id` desnormalizado**, para o RLS usar a mesma
     policy das outras tabelas. O DER muda junto.
4. **Membro do espaço:**
   - `role_assignments` com `scope_type='space'`, `space_id`, `organization_id` e um papel de espaço do catálogo;
   - índice único parcial: uma atribuição ativa por (`space_id`, `user_id`) com `scope_type='space'`;
   - o RLS de `role_assignments` já é por organização, então só é preciso conferir que as policies aceitam as
     linhas de espaço (incluindo a `self_read`).
5. **Lock da regra do último Gestor:** `SpaceRoleRepository.lockSpaceManagers(spaceId): Promise<string[]>`, com
   `FOR UPDATE OF ra`, em ordem estável, dentro do unit of work. Mesmo padrão do `lockOrgAdmins`.
6. **Troca de chave:**
   - `POST /spaces/:id/keys` com `{ version, recoveryPublicKey, recoveryWrappedKey, grants: [{ userId, wrappedKey }] }`;
   - corre dentro do unit of work com o espaço travado (`SELECT ... FOR UPDATE` na linha de `spaces`);
   - confere `version === current_key_version + 1` e que o conjunto de `userId` dos grants é **exatamente** o
     conjunto de membros ativos do espaço. Qualquer divergência: `ConflictError('key-rotation-mismatch')`;
   - quem envia precisa ser membro ativo; não precisa ser Gestor.
7. **Pôr alguém:**
   - `grants: [{ version, wrappedKey }]` cobrindo **todas** as versões existentes. Senão
     `ConflictError('key-versions-mismatch')`;
   - o espaço é travado durante a operação, para uma troca de chave concorrente não deixar a pessoa sem a versão
     nova.
8. **Saída da organização:**
   - o `MemberRemovedHooks.run({ organizationId, userId, actorId, now })` é chamado pelo `RemoveMemberUseCase` e
     pelo `LeaveOrganizationUseCase`, dentro do unit of work deles;
   - o gancho do `spaces`:
     - grava lápide nas atribuições de espaço e nas cópias da pessoa em todos os espaços da organização;
     - marca `key_rotation_required` nos espaços afetados;
     - cancela as pendências de trancar dela;
     - audita;
   - pode deixar espaço sem Gestor ou órfão: isso é permitido.
9. **Convite com espaços:**
   - o `CreateInvitationUseCase` passa `spaces?: [{ spaceId, roleKey }]` para `InvitationHooks.validateAndRecord({ organizationId, invitationId, actorId, spaces })`
     dentro do mesmo unit of work;
   - o `spaces` valida e grava as intenções, ou lança: `PermissionDeniedError` se quem convida não é Gestor do
     espaço, `NotFoundError` se o espaço não existe ou é de outra organização;
   - o `AcceptInvitationUseCase` chama `InvitationHooks.onAccepted({ organizationId, invitationId, userId })`, e o
     `spaces` cria as `space_pending_grants`;
   - os resultados não voltam ao cliente do aceite. Ele só vê a organização.
10. **Reabertura pelo kit (órfão):**
    - `POST /spaces/:id/recover` com `{ grants: [{ version, wrappedKey }], currentAuthProof }`;
    - a reautenticação acontece antes do unit of work;
    - exige `org.members.manage` e o espaço sem **nenhum** membro ativo, senão `ConflictError('space-not-orphan')`;
    - o admin entra como `space_manager`;
    - auditoria: `space.recovered_with_kit`;
    - throttle: `@ThrottleReauth()`.
11. **Promover Gestor:**
    - `POST /spaces/:id/managers` com `{ userId }`;
    - exige `org.members.manage`, o espaço sem Gestor ativo e o alvo já membro ativo do espaço. Senão
      `ConflictError('space-has-manager')` ou `NotFoundError`;
    - auditoria: `space.manager_promoted`.
12. **Auditoria nova:** `space.created`, `space.renamed`, `space.member_added`, `space.member_removed`,
    `space.member_left`, `space.member_role_changed`, `space.key_rotated`, `space.recovery_rewrapped`,
    `space.recovered_with_kit`, `space.manager_promoted`, `space.pending_grant_declined`. O `metadata` nunca
    carrega cópia trancada.
13. **Listas:**
    - `GET /organizations/:orgId/spaces` devolve os espaços em que eu estou, com `roleKey` e as flags
      `keyRotationRequired`, `recoveryRewrapRequired` e `pendingGrants` (contagem, só para Gestor);
    - `?all=true` precisa de `org.spaces.create` e devolve todos os espaços, só com `id`, `name`, `memberCount` e
      `createdAt`.

## Global Constraints
- **Código:** ESM com `.js`, Vitest, oxlint sem avisos e Prettier.
- **Camadas:** domínio puro. Um módulo não importa a `infra/` nem o `domain/` de outro, só o que o outro
  exporta da `application/`. Contratos como classes abstratas.
- **API:** `camelCase`, ISO UTC, cursor, `problem+json` com `type` estável. Formato no DTO, regra no domínio.
- **Banco:** UUID v7; timestamps; lápide; `sync_version` nas sincronizáveis (`spaces`, `space_keys`,
  `space_key_grants`). Migrations novas com `down`, sem editar as aplicadas. `npm run schema:check` vazio. RLS sem
  `SECURITY DEFINER`, testado pelo papel de runtime.
- **Segredos:** o backend nunca recebe nem guarda a chave do espaço em claro. Cópia trancada nunca vai para log,
  auditoria ou mensagem de erro.
- **Fluxo:** commits pequenos direto na `develop`, com push a cada commit. Pronto =
  `npm run build && npm test && npm run lint`, `npm run test:e2e` no container, `schema:check` e CI verde. Os
  e2e rodam com `docker exec vaulter-back-app npx vitest run --config vitest.config.e2e.ts <arquivo>`.

## Review Focus
1. **Admin fora do espaço:** não lê os detalhes, membros nem chaves (404); não se põe nem põe ninguém; só promove
   membro existente quando falta Gestor; só se reabre pelo kit com o espaço órfão, reautenticado e auditado.
   (Tasks 6 e 7)
2. **Troca de chave concorrente com entrada de membro:** ninguém fica de fora da versão nova, e a versão nova nunca
   tem cópia para quem saiu. (Tasks 5, 6 e 7)
3. **Saída da organização:** tira a pessoa de todos os espaços na mesma transação e marca a troca pendente; uma
   falha no gancho desfaz a remoção inteira. (Tasks 4 e 7)
4. **Kit trocado no meio de uma operação:** criar, trocar a chave ou retrancar com o kit antigo responde 409, e
   nenhuma versão fica sem cópia para o kit atual sem aparecer como pendente. (Tasks 6 e 7)
5. **Isolamento:** um espaço de outra organização nunca aparece, nem com um `spaceId` válido de lá em qualquer
   rota, inclusive na intenção de espaço do convite. (Tasks 5 e 7)

---

### Task 1: DER (`.sql` e `.mwb`)
**Files:** `docs/der_model.sql` e `docs/der_model.mwb`.
- [ ] No `.sql`:
  - `spaces.key_rotation_required`;
  - `space_keys.recovery_key_fingerprint` e `organization_id`;
  - `space_key_grants.organization_id`;
  - tabelas novas `space_pending_grants` e `invitation_space_intents` (decisão 3), com FKs, índices e
    comentários;
  - comentário em `role_assignments` sobre o escopo de espaço, com o índice único parcial descrito em comentário.
- [ ] No `.mwb`: as mesmas mudanças, editando o XML como nos módulos anteriores. Validar parse, referências, ids
  únicos, figuras sem sobreposição e abertura no Workbench sem interface. Commitar
  `docs: spaces changes in data model`.

### Task 2: Formato da cópia trancada e lado do cliente
**Files:**
- `docs/crypto/user-keys.md`, com a seção "Chave de espaço" (decisões 1 e 2 e o vetor de teste);
- `test/support/client-crypto.ts`:
  - `generateSpaceKey(): Promise<Uint8Array>`;
  - `sealSpaceKey(spaceKey, recipientPublicKeyB64u): Promise<string>`;
  - `openSpaceKey(wrappedB64u, publicKeyB64u, privateKey): Promise<Uint8Array>`;
  - `recoveryKitKeypair(): Promise<{ publicKey, privateKey }>`;
- `test/support/client-crypto.spec.ts`;
- `src/spaces/domain/wrapped-key.ts`, com `assertWrappedSpaceKey` e spec, e
  `recoveryKeyFingerprint(publicKeyB64u): string` (puro, usando BLAKE2b?). O domínio fica sem libsodium; a
  impressão é calculada na infra por um port `KeyFingerprinter` (application/ports) e a implementação usa a
  libsodium.
- [ ] Testes:
  - selar e abrir com o par certo; não abrir com o par errado;
  - o tamanho é 81 com versão 1;
  - `assertWrappedSpaceKey` aceita a cópia real e recusa tamanho errado, versão 2, padding e `+/`;
  - a impressão é determinística, tem 64 caracteres hex e muda com a chave.
- [ ] Commitar `feat(spaces): wrapped space key format and client helpers`.

### Task 3: Domínio do `spaces`
**Files:** `src/spaces/domain/{space,space-membership,key-rotation}.ts` com specs, mais os contratos de
repositório (`*.repository.ts`).

**Interfaces:**
- `Space`:
  - `create({ organizationId, name, now })`, que nasce com `currentKeyVersion = 1`;
  - `restore`;
  - `rename` (1–255, com trim);
  - `markRotationRequired()`;
  - `completeRotation(nextVersion)`, que confere `nextVersion === current + 1` e limpa a flag;
  - getters.
- `SpaceMembershipRules`:
  - `assertCanRemove(targetRole, { isLastManager, hasOtherMembers })`, `assertCanLeave(...)` e
    `assertCanChangeRole(...)`, com o código `last-space-manager`;
  - `assertSpaceRole(roleKey)`, que aceita só `space_reader`, `space_editor` e `space_manager` (código
    `role-invalid`);
  - `isLastManager(managerIds, target)`.
- `KeyRotationRules`:
  - `assertGrantsMatchMembers(grantUserIds, activeMemberIds)` (`key-rotation-mismatch`);
  - `assertGrantsCoverVersions(grantVersions, existingVersions)` (`key-versions-mismatch`);
  - `assertNoDuplicates`.
- `OrphanRules`: `assertOrphan(activeMemberCount)` (`space-not-orphan`) e `assertNoManager(managerCount)`
  (`space-has-manager`).
- Contratos:
  - `SpaceRepository`:
    - `create`;
    - `save`;
    - `findById(orgId, spaceId)`;
    - `lockForUpdate(orgId, spaceId)`;
    - `listForMember(orgId, userId, page)`;
    - `listAll(orgId, page)` com contagem de membros;
  - `SpaceKeyRepository`:
    - `addVersion(orgId, spaceId, version, recoveryWrappedKey, fingerprint)`;
    - `versions(orgId, spaceId)`;
    - `setRecoveryWrap(orgId, spaceId, version, wrappedKey, fingerprint)`;
  - `SpaceGrantRepository`:
    - `upsert(orgId, spaceKeyId, userId, wrappedKey)` (limpa a lápide);
    - `forUser(orgId, spaceId, userId)`;
    - `tombstoneUser(orgId, spaceId, userId)`;
    - `tombstoneUserInOrg(orgId, userId): Promise<string[]>` (espaços afetados);
  - `SpaceRoleRepository`:
    - `assign`;
    - `roleOf`;
    - `remove`;
    - `activeMemberIds(orgId, spaceId)`;
    - `lockSpaceManagers(orgId, spaceId)`;
    - `removeUserInOrg(orgId, userId)`;
  - `PendingGrantRepository`:
    - `create`;
    - `listPending(orgId, spaceId, page)`;
    - `decline`;
    - `markGranted(orgId, spaceId, userId)`;
    - `cancelForUser(orgId, userId)`;
  - `SpaceIntentRepository`: `record(orgId, invitationId, intents)` e `forInvitation(orgId, invitationId)`.
- [ ] Testes unitários de cada regra. Commitar `feat(spaces): space, membership and key rotation domain`.

### Task 4: Ganchos compartilhados e integração no `organizations`
**Files:**
- `src/shared/application/{member-removed-hooks,invitation-hooks}.ts` com specs, registrados no
  `SharedApplicationModule`;
- `src/organizations/application/{remove-member,leave-organization,create-invitation,accept-invitation}.use-case.ts`;
- os DTOs de convite (`spaces?: [{ spaceId: uuid, roleKey }]`, no máximo 20);
- `src/organizations/organizations.module.ts`, que passa a exportar `OrganizationDirectory`.

**Interfaces:**
- `MemberRemovedHooks.register/unregister/run(ctx)`, com
  `ctx = { organizationId, userId, actorId, reason: 'removed' | 'left', now }`, sequencial; erro desfaz.
- `InvitationHooks.register/unregister`, `validateAndRecord(ctx)` e `onAccepted(ctx)`. Os dois só rodam se houver
  algum inscrito, e `validateAndRecord` só quando `spaces` vier preenchido.
- `OrganizationDirectory` (application do `organizations`, exportado):
  - `isActiveMember(orgId, userId)`;
  - `recoveryPublicKey(orgId): Promise<string | null>`;
  - `requirePermission`, reexpondo o `OrganizationAccess` (ou exportar o próprio `OrganizationAccess`, que já é
    exportado).
- [ ] Testes:
  - unitários dos registros;
  - os use cases chamam os ganchos dentro do unit of work, com o contexto certo;
  - um gancho que lança desfaz a remoção ou a criação do convite (e2e no Task 7);
  - a suite atual continua verde.
- [ ] Commitar `feat(organizations): member-removed and invitation hooks for dependent modules`.

### Task 5: Tabelas, RLS e repositórios do `spaces`
**Files:**
- migration `CreateSpaces`: `spaces`, `space_keys`, `space_key_grants`, `space_pending_grants`,
  `invitation_space_intents`, o índice parcial de atribuição de espaço, RLS por organização em todas as tabelas
  e `sync_version` nas três sincronizáveis;
- as entidades, os mappers e os repositórios em `src/spaces/infra/db/`;
- `src/spaces/spaces.module.ts`, importado no `AppModule`;
- `test/spaces/repositories.e2e-spec.ts`.
- [ ] Testes, sempre pelo papel de runtime:
  - uma organização não vê espaços, chaves, cópias, pendências nem intenções de outra;
  - `lockForUpdate` e `lockSpaceManagers` serializam;
  - `tombstoneUserInOrg` devolve os espaços afetados e não toca outra organização;
  - reentrada limpa a lápide da cópia;
  - `sync_version` nas sincronizáveis;
  - as policies de `role_assignments` aceitam linhas de espaço e a `self_read` continua restrita ao próprio
    usuário;
  - `schema:check` vazio e `migration:revert` + `run`.
- [ ] Commitar `feat(spaces): space tables with row-level security`.

### Task 6: Casos de uso do `spaces`
**Files:** `src/spaces/application/*`: os use cases, `space-access.ts` (exportado), os ganchos inscritos
(`member-removed.hook.ts`, `invitation.hook.ts`), `ports/key-fingerprinter.ts` e o adapter libsodium na infra, os
DTOs de saída e as specs.

**Interfaces** (todas as mutações no unit of work):

| Caso de uso | O que faz |
|---|---|
| `CreateSpaceUseCase.execute(actor, orgId, { name, wrappedKey, recoveryPublicKey, recoveryWrappedKey })` | sem kit: `DomainValidationError('recovery-key-required')`; kit diferente: `recovery-key-changed` |
| `ListSpacesUseCase.execute(actor, orgId, { all, page })` | lista os meus espaços, ou todos com `all` |
| `GetSpaceUseCase` | detalhes do espaço |
| `RenameSpaceUseCase` | renomeia |
| `ListSpaceMembersUseCase` | membros, com `publicKey` pelo `UserDirectory` |
| `AddSpaceMemberUseCase.execute(actor, spaceId, { userId, roleKey, grants })` | trava o espaço; o alvo precisa ser membro ativo da organização; marca a pendência como `granted` |
| `ChangeSpaceMemberRoleUseCase` | troca o papel |
| `RemoveSpaceMemberUseCase` | tira e marca a troca pendente |
| `LeaveSpaceUseCase` | sai e marca a troca pendente |
| `GetMyKeysUseCase` | `{ currentVersion, keys: [{ version, wrappedKey }] }` |
| `RotateSpaceKeyUseCase` | decisão 6 |
| `RewrapRecoveryUseCase.execute(actor, spaceId, { recoveryPublicKey, versions: [{ version, wrappedKey }] })` | precisa cobrir todas as versões cuja impressão difere |
| `PromoteSpaceManagerUseCase` | decisão 11 |
| `RecoverOrphanSpaceUseCase` | decisão 10 |
| `ListPendingGrantsUseCase` | pendências do espaço |
| `DeclinePendingGrantUseCase` | recusa uma pendência |

`SpaceAccess`:
- `requireSpaceMember(spaceId, userId) → { space, roleKey }`: quem não é membro do espaço recebe
  `NotFoundError('space-not-found')`, mesmo sendo admin da organização;
- `requireSpacePermission(spaceId, userId, permission)`: o membro sem a permissão recebe
  `PermissionDeniedError`;
- o espaço é resolvido para a organização dele com o contexto certo.

- [ ] Testes unitários com mocks de cada caso de uso, regra, erro e auditoria. A cópia trancada nunca aparece em
  auditoria ou erro.
- [ ] Commitar `feat(spaces): use cases for spaces, members and keys`.

### Task 7: HTTP e e2e
**Files:**
- `src/spaces/infra/http/{spaces,space-members,space-keys}.controller.ts` e os DTOs (rotas da spec §7);
- `test/spaces/*.e2e-spec.ts`;
- `test/support/identity-client.ts` (helpers de espaço, usando o lado do cliente do Task 2).
- [ ] e2e, sempre com o lado do cliente real (selar e abrir):
  - **criação:**
    - criar com kit;
    - sem kit: 422 `recovery-key-required`;
    - kit trocado no meio: 409 `recovery-key-changed`;
  - **membros:**
    - Gestor põe alguém com todas as versões, e a pessoa abre todas as cópias com a própria chave privada;
    - faltando uma versão: 409 `key-versions-mismatch`;
    - alvo fora da organização: 404 ou 422;
  - **acesso de não membro:**
    - admin da organização fora do espaço recebe 404 nos detalhes, membros e chaves;
    - admin fora do espaço não consegue pôr ninguém, nem a si mesmo;
  - **saída e troca de chave:**
    - tirar alguém marca `keyRotationRequired`;
    - a troca com os membros certos funciona, a pessoa que saiu não recebe a versão nova e os que ficaram abrem
      a v2;
    - troca com membro a mais ou a menos: 409;
    - entrada concorrente com uma troca: não deixa ninguém de fora;
    - último Gestor: 422;
  - **saída da organização:**
    - tira a pessoa de todos os espaços e marca a troca;
    - um gancho que falha desfaz tudo;
  - **kit novo:**
    - `recoveryRewrapRequired` fica verdadeiro depois de trocar o kit;
    - retrancar com o kit atual limpa a flag;
    - retrancar com o kit antigo: 409;
  - **espaço órfão e sem Gestor:**
    - espaço com membros: 409 `space-not-orphan`;
    - espaço órfão reaberto: o admin abre as cópias, e a auditoria `space.recovered_with_kit` existe;
    - prova errada: 422;
    - promover Gestor em espaço sem Gestor funciona; em espaço com Gestor: 409;
  - **convite com espaços:**
    - indicar um espaço sem ser Gestor: 403;
    - espaço de outra organização: 404;
    - o aceite cria uma pendência, o Gestor vê, tranca e a pessoa entra; recusar funciona;
  - **isolamento:** um `spaceId` de outra organização dá 404 em todas as rotas;
  - **documentação:** o Swagger público continua sem as rotas.
- [ ] Commitar `feat(spaces): spaces endpoints`.

### Task 8: Documentação e verificação final
- [ ] `CLAUDE.md`:
  - o módulo `spaces` e o mapa de dependências;
  - o `SpaceAccess` como padrão para Hubs;
  - os ganchos `MemberRemovedHooks` e `InvitationHooks`;
  - o fluxo de chaves (versões, troca, retrancamento, órfão);
  - as tabelas novas e as exceções;
  - as pendências que sobraram: Hubs, storage, nuvem ativa, excluir espaço, papéis próprios de espaço.
- [ ] A verificação completa, o `schema:check` e o CI verde. Commitar `docs: document spaces module`.
