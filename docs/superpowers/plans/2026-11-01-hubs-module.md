# Módulo `hubs` — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hubs registrados com identidade criptográfica (apresentação, reivindicação, autenticação por desafio
assinado), vínculo com organizações em dois consentimentos (incluindo código de vínculo), espaços no Hub, Sala com
cópia da chave trancada para o Hub, papéis de Hub, desregistro e sincronização por HTTP para o Hub funcionar offline.

**Architecture:** É um módulo novo, `src/hubs/`, com as camadas `domain` / `application` / `infra`. As dependências
vão num sentido só:
- **`hubs` → `identity`:** um `HubTokenService` novo, exportado pela `application/` do `identity`, que emite e
  verifica o token de Hub com as mesmas chaves e rotação por `kid`; e `UserDirectory`.
- **`hubs` → `organizations`:** `OrganizationAccess`, `OrganizationDirectory` (que ganha `hubLinkPolicy` e
  `allowRoomSpaces`) e `AuditLog`.
- **`hubs` → `spaces`:** `SpaceAccess` e um `SpaceRoomService` novo. As tabelas de chave e as atribuições de
  espaço são do `spaces`, então quem grava as cópias para o Hub e o papel da Sala no espaço é ele, e a troca de
  chave passa a contar os Hubs da Sala.
- **`spaces` não conhece `hubs`:** ele emite `SpaceMemberLeftHooks`, novo em `shared/application`, e o `hubs`
  assina. Saída da organização: `MemberRemovedHooks`, que já existe.

As rotas do Hub autenticado ficam sob `/hub/...` e passam por um `HubTokenGuard`. Elas são `@Public()` para o
guard de usuário, que já recusa token de outro `typ`.

**Tech Stack:** NestJS 12, TypeORM 1, PostgreSQL 18 (RLS), Vitest, `libsodium-wrappers-sumo` (Ed25519), `jose`.

**Spec:** `docs/superpowers/specs/2026-11-01-hubs-design.md` (aprovada em 01/11/2026). Contexto: `CLAUDE.md`
(módulos `identity`, `organizations` e `spaces`, unit of work, RLS, rate limit), `docs/crypto/user-keys.md` e
`docs/der_model.sql`.

## Decisões deste plano
1. **Mensagens assinadas pelo Hub:**
   - Ed25519 destacada (`crypto_sign_detached`) sobre `rótulo ‖ 0x00 ‖ campos`, com os campos em JSON canônico
     (chaves ordenadas, sem espaços) em UTF-8;
   - rótulos sem o nome do produto: `hub-enroll-v1`, `hub-status-v1`, `hub-auth-v1`;
   - chaves e assinatura em base64url sem padding (assinatura de 64 bytes, 86 caracteres);
   - tudo documentado em `docs/crypto/hub-identity.md`, com vetor de teste.
2. **Apresentação:** `{ signingPublicKey, encryptionPublicKey, nonce(16 bytes b64u), timestamp(ISO) }` assinados com
   `hub-enroll-v1`.
   - O timestamp precisa estar a ±5 min do servidor.
   - O `nonce` é de uso único: está na própria linha de apresentação, com índice único em
     `(signing_public_key, nonce)`.
   - Código de reivindicação: 8 dígitos, gerado por CSPRNG, guardado como hex de `crypto_generichash(32, code)`
     com uma chave do servidor (`HUB_CODE_HASH_KEY`, novo segredo no `.env`, para um banco vazado não permitir
     buscar os códigos por força bruta). Vale 10 min.
3. **Consulta de status:** cabeçalhos `X-Hub-Signature` e `X-Hub-Timestamp`, assinados com `hub-status-v1` sobre
   `{ enrollmentId, timestamp }`, com ±5 min de tolerância. Devolve `{ status: 'pending' | 'expired' }` ou
   `{ status: 'claimed', hubId }`.
4. **Autenticação do Hub:**
   - `POST /hub-auth/challenge { hubId }` devolve `{ challenge(32 bytes b64u), expiresAt(+60 s) }`. A tabela
     `hub_auth_challenges` (só backend) guarda o hash e o `used_at`; um Hub inexistente recebe um desafio
     indistinguível, que nunca valida (sem oráculo);
   - `POST /hub-auth/token { hubId, challenge, signature }` confere a assinatura (`hub-auth-v1`, sobre
     `{ hubId, challenge }`), consome o desafio de forma atômica e devolve o token;
   - token: JWT EdDSA com `typ: 'hub+jwt'`, `sub = hubId`, o `aud` do `.env` e o `kid` atual, válido por 15 min;
   - a cada requisição o guard confere a assinatura e que o Hub existe e não está desregistrado.
5. **Tabelas novas e mudanças:**
   - `hubs`: renomear `public_key` para `encryption_public_key`, mais `signing_public_key UNIQUE` (sem
     `WHERE deleted_at`: única para sempre), `owner_user_id`, `name` e `last_seen_at`; sincronizável;
   - `hub_enrollments`: `signing_public_key`, `encryption_public_key`, `nonce`, `claim_code_hash` (único entre
     pendentes), `expires_at`, `status` e `claimed_hub_id`; não sincroniza, sem RLS de organização;
   - `hub_link_codes`: `hub_id`, `code_hash` (único entre os vigentes), `expires_at` e `used_at`; não sincroniza;
   - `hub_auth_challenges`: `hub_id` nulo (desafio falso), `challenge_hash`, `expires_at` e `used_at`; não
     sincroniza;
   - `hub_organization`: colunas do DER mais `owner_approved_by_user_id`, `owner_approved_at`,
     `org_approved_by_user_id`, `org_approved_at` e `status` (`pending` | `approved` | `rejected` | `revoked`);
     sincronizável;
   - `hub_space`: com `organization_id` e FK composta para `spaces`; sincronizável;
   - `organizations.allow_room_spaces boolean default true`.
   - `hub_enrollments`, `hub_link_codes` e `hub_auth_challenges` ficam fora do RLS de organização. O acesso é só
     pelos repositórios do `hubs`, sempre pela chave ou pelo hash. **Não** é dado de cliente.
6. **RLS de `hubs` e do escopo Hub:**
   - `hubs`: SELECT quando `owner_user_id = app.user_id`, OU `id = app.hub_id` (Hub autenticado), OU `EXISTS` vínculo
     aprovado com uma organização de que `app.user_id` é membro ativo (pelas policies já existentes de
     `user_organization`); UPDATE e INSERT pelo dono ou pelo contexto de reivindicação (`app.user_id` igual ao
     `owner_user_id` gravado);
   - `hub_organization`: a policy da organização, mais leitura pelo dono do Hub (`EXISTS hubs` com
     `owner_user_id = app.user_id`) e pelo próprio Hub (`hub_id = app.hub_id`);
   - `role_assignments` com `scope_type = 'hub'` têm `organization_id` nulo, então ganham uma policy adicional: o
     dono do Hub lê e grava, o próprio Hub lê e cada usuário lê a própria linha (`self_read`, que já existe);
   - nova chave de contexto `app.hub_id` no `UnitOfWork.withContext` e `setContext`.
7. **`SpaceRoomService`** (exportado pelo `spaces`):
   - `grantRoom(actor, { hubId, spaceId, roleKey, recoveryPublicKey, grants })`: o ator precisa ser
     `space_manager`; os `grants` têm a cópia de todas as versões para a `encryption_public_key` do Hub; grava as
     cópias em `space_key_grants.hub_id`, o papel da Sala (`role_assignments.room_hub_id` com escopo espaço) e a
     auditoria `hub.room.granted`;
   - `revokeRoom(actorOrSystem, { hubId, spaceId, reason })`: lápide nas cópias e no papel, `keyRotationRequired` e
     auditoria;
   - `revokeAllRoomForHub(hubId)` e `revokeRoomForOrganization(hubId, orgId)`, para desregistrar e desvincular;
   - **troca de chave:** `RotateSpaceKeyUseCase` passa a receber `hubGrants: [{ hubId, wrappedKey }]` e exige o
     conjunto exato de Hubs ativos da Sala;
   - `SPACE_MAX_MEMBERS` conta pessoas e Hubs;
   - o `hubs` passa a chave pública do Hub e a confirmação de que o Hub está vinculado e aprovado. O `spaces` não
     consulta `hubs`.
8. **`SpaceMemberLeftHooks`** (novo, em `shared/application`): é emitido pelo `spaces` em Remove e Leave e pelo
   gancho de saída da organização, sempre por espaço, com `{ organizationId, spaceId, userId, now }`. O `hubs`
   assina: se o usuário é dono de Hubs com aquele espaço liberado na Sala, chama `revokeRoom` para eles.
9. **Sincronização:**
   - `GET /hub/sync?since=<n>&limit=<≤500>` devolve `{ items: [{ type, syncVersion, deleted, data }], nextSince }`,
     com `type` em `hub`, `hub_organization`, `organization`, `member`, `role_assignment`, `space`, `space_key`,
     `space_key_grant` e `hub_space`;
   - `member` leva `userId`, `name`, `email`, `publicKey`, `encryptedPrivateKey`, `kdfSalt`, `kdfParams` e os
     papéis; **nunca** `authHash`;
   - escopo: só organizações com vínculo `approved`; espaços só os de `hub_space`; cópias da chave só desses
     espaços, para pessoas ou para este Hub;
   - lápides inclusas (`withDeleted`). Itens que saíram do escopo, como um vínculo revogado, aparecem como lápide
     do próprio vínculo, e o Hub apaga em cascata.
   - É uma consulta por tipo, com `sync_version > since`, mesclada por `syncVersion`.
10. **Rate limits novos:**
    - `hubEnroll`: 20/h por IP;
    - `hubStatus`: 120/h por IP;
    - `hubAuth`: 60/h por IP, nas duas rotas;
    - `hubClaim`: 10/h por usuário;
    - `hubLinkRequest`: 10/h por usuário;
    - `hubLinkCode`: 30/h por Hub;
    - `hubSync`: 120/h por Hub.
11. **Auditoria:** as ações da spec §8, na organização afetada. Ações sem organização (`hub.claimed`,
    `hub.deregistered`) vão para a organização pessoal do dono.

## Global Constraints
- **Código:** ESM com `.js`, Vitest, oxlint sem avisos, Prettier e typecheck limpo.
- **Camadas:** domínio puro. Um módulo não importa `infra/` nem `domain/` de outro; contratos como classes
  abstratas.
- **API:** `camelCase`, ISO UTC, cursor, `problem+json` com `type` estável. Formato no DTO, regra no domínio.
- **Banco:** UUID v7; timestamps; lápide; `sync_version` nas sincronizáveis. Migrations novas com `down`, sem
  editar as aplicadas. `schema:check` vazio. RLS sem `SECURITY DEFINER`, testado pelo papel de runtime. FKs
  compostas com a organização onde houver filho de organização.
- **Segredos:** chave privada do Hub, cópias trancadas, códigos e desafios nunca vão para log, auditoria ou erro.
  Códigos e desafios ficam no banco só como hash.
- **Nome do produto:** nunca em rótulos de cripto nem no código.
- **Fluxo:** commits pequenos direto na `develop`, com push a cada commit. Pronto =
  `npm run build && npm test && npm run lint && npm run typecheck`, `npm run test:e2e` e `npm run schema:check` no
  container, e CI verde.

## Review Focus
1. **Hub falso:** ninguém se passa por um Hub sem a chave privada. Isso cobre desafio reusado, assinatura sobre
   outro rótulo, Hub desregistrado e token de Hub usado em rota de usuário (e o contrário). (Tasks 2, 6 e 9)
2. **Dados fora do vínculo:** organização sem vínculo aprovado nunca aparece na sincronização nem nas rotas do Hub;
   desvincular faz o vínculo sair como lápide. (Tasks 5, 8 e 9)
3. **Sala e troca de chave:** a troca exige cópia para cada Hub da Sala, e Hub sem vínculo ou desregistrado não
   recebe a versão nova. (Tasks 4 e 9)
4. **Códigos:** o código de reivindicação e o de vínculo não podem ser adivinhados (rate limit, uso único, hash com
   chave) e nunca revelam se um Hub existe. (Tasks 6, 7 e 9)
5. **Saídas em cascata:** dono sai do espaço, pessoa sai da organização, desvincular, desregistrar. Cada uma tira o
   que deve, na mesma transação, e falha desfaz tudo. (Tasks 4, 7 e 9)

---

### Task 1: DER (`.sql` e `.mwb`)
**Files:** `docs/der_model.sql` e `docs/der_model.mwb`.
- [ ] Mudanças da decisão 5, com comentários.
- [ ] O `.mwb` editado pelo XML, como nos módulos anteriores: FKs de várias colunas, ids únicos, figuras sem
  sobreposição e validação headless no Workbench.
- [ ] Commitar `docs: hubs changes in data model`.

### Task 2: Identidade criptográfica do Hub
**Files:**
- `docs/crypto/hub-identity.md`;
- `test/support/hub-crypto.ts`, com `createHubIdentity()`, `signEnrollment`, `signStatus` e `signAuth`;
- `src/hubs/domain/hub-keys.ts`, com `assertSigningPublicKey` e `assertEncryptionPublicKey` (32 bytes, base64url
  estrito);
- `src/hubs/application/ports/{hub-signature-verifier,hub-code-hasher}.ts`;
- `src/hubs/infra/crypto/{sodium-hub-signature-verifier,sodium-hub-code-hasher}.ts`, com specs;
- `env.validation` (`HUB_CODE_HASH_KEY`) e `.env.example`.

**Interfaces:**
- `HubSignatureVerifier.verify(label, fields, signatureB64u, signingPublicKeyB64u): Promise<boolean>`;
- `HubCodeHasher.newCode(): string` (8 dígitos) e `hash(code): Promise<string>`;
- `HubCodeHasher.newChallenge(): string` e `hashChallenge`.

- [ ] Testes:
  - um vetor de teste fixo verifica;
  - recusa outro rótulo, campo adulterado ou chave errada;
  - a serialização canônica independe da ordem das chaves;
  - o código tem 8 dígitos e a distribuição é uniforme (sanidade);
  - o hash do código depende de `HUB_CODE_HASH_KEY`.
- [ ] Commitar `feat(hubs): hub identity signatures and code hashing`.

### Task 3: Domínio do `hubs`
**Files:** `src/hubs/domain/{hub,enrollment,link-code,hub-organization-link,hub-roles}.ts` com specs, mais os
contratos `*.repository.ts`.

**Interfaces:**
- `Hub`: `claim({ enrollment, ownerUserId, name, now })`, `rename`, `deregister(now)`, `touch(now)`.
- `Enrollment`: `issue({ keys, nonce, codeHash, now })` com 10 min; `assertClaimable(now)` com
  `claim-code-invalid`; `markClaimed(hubId)`.
- `LinkCode`: `issue` e `consume`, com `link-code-invalid`.
- `HubOrganizationLink`, máquina de estados:
  - `ownerLinks(policy)`: aprovado se a política for `any_member_hub`, senão pendente do lado da organização;
  - `requestByOther(policy)`: pendente do lado do dono, e também do lado da organização se `admin_approved`;
  - `approveAsOwner` e `approveAsOrgAdmin`;
  - `reject`, `revoke` e o getter `isActive`.
  - Erros: `link-not-pending` e `already-linked`.
- `HubRoleRules`: só `hub_operator` ou `hub_user` são atribuíveis (`role-invalid`); o dono não muda o próprio papel
  (`hub-owner-protected`).
- Contratos:
  - `HubRepository`: `create`, `save`, `findById`, `findBySigningKey`, `listForUser(userId, page)` e
    `lockForUpdate`;
  - `EnrollmentRepository`: `create`, `findById`, `findPendingByCodeHash`, `markClaimed` (condicional) e
    `expireStale`;
  - `LinkCodeRepository`: `create` e `consume` (condicional);
  - `AuthChallengeRepository`: `create` e `consume` (condicional);
  - `HubOrganizationRepository`: `find`, `upsert` (revive a lápide), `list(hubId)`, `listActiveOrgIds(hubId)` e
    `lockForUpdate`;
  - `HubSpaceRepository`: `add`, `remove` e `list`;
  - `HubRoleRepository`: `assign`, `remove`, `list` e `removeUsersWithoutLinkedOrg(hubId)`.
- [ ] Testes unitários de cada regra e da máquina de estados. Commitar
  `feat(hubs): hub, enrollment and organization link domain`.

### Task 4: Integração com `organizations`, `spaces` e `identity`
**Files:**
- `organizations`: migration `allow_room_spaces`, entidade, DTO do `PATCH`, `OrganizationDirectory`
  (`hubLinkPolicy`, `allowRoomSpaces`);
- `spaces`: `SpaceRoomService`, a mudança no `RotateSpaceKeyUseCase` (`hubGrants`), o `SPACE_MAX_MEMBERS` contando
  Hubs, a emissão do `SpaceMemberLeftHooks` e os helpers e2e do lado do cliente
  (`rotate` com `hubGrants`);
- `shared/application/space-member-left-hooks.ts`;
- `shared/infra/db/unit-of-work.ts` (contexto `app.hub_id`);
- `identity`: `HubTokenService` (exportado), com a implementação em `jose` reaproveitando o mapa de chaves do
  `JoseAccessTokenService`, e `typ: 'hub+jwt'`.
- [ ] Testes:
  - `grantRoom` exige Gestor, todas as versões e a chave do Hub informada;
  - `revokeRoom` marca a troca pendente;
  - a troca de chave sem as cópias dos Hubs da Sala dá 409 `key-rotation-mismatch`, e com as cópias passa;
  - o limite de membros conta Hubs;
  - o gancho de saída do espaço é emitido em Remove, Leave e saída da organização;
  - o token de Hub não passa no guard de usuário, e o token de usuário não passa no `HubTokenService.verify`;
  - as suítes atuais continuam verdes (os helpers de troca de chave passam `hubGrants: []`).
- [ ] Commitar `feat(spaces): room grants for hubs and space-left hooks` e
  `feat(identity): hub access tokens`.

### Task 5: Tabelas, RLS e repositórios do `hubs`
**Files:**
- a migration `CreateHubs`, com as tabelas da decisão 5, as policies da decisão 6, os triggers de sync e as FKs
  compostas;
- as entidades, os mappers e os repositórios em `src/hubs/infra/db/`;
- `src/hubs/hubs.module.ts`, importado no `AppModule`;
- `test/hubs/repositories.e2e-spec.ts`.
- [ ] Testes, sempre pelo papel de runtime:
  - **visibilidade de `hubs`:** o dono vê; um membro de organização com vínculo aprovado vê; alguém de outra
    organização não vê; o próprio Hub (`app.hub_id`) vê;
  - **`hub_organization`:** isolamento entre organizações;
  - **papéis de Hub:** só o dono grava; cada pessoa lê a própria linha;
  - **consumos condicionais:** de código e de desafio concorrentes, só um vence;
  - **chave de assinatura:** única mesmo depois de desregistrar;
  - **`hub_space`:** FK composta recusa espaço de outra organização;
  - `schema:check` vazio e `migration:revert` + `run`.
- [ ] Commitar `feat(hubs): hub tables with row-level security`.

### Task 6: Apresentação, reivindicação e autenticação do Hub
**Files:** `src/hubs/application/{enroll-hub,enrollment-status,claim-hub,issue-hub-challenge,issue-hub-token}.use-case.ts`,
`hub-token.guard.ts` (infra/http), `hub-auth.decorators.ts` (`@HubAuth()` e `@CurrentHub()`) e as specs.
- [ ] Testes:
  - apresentação com assinatura válida, timestamp fora da janela, `nonce` repetido ou chave já usada por um Hub
    (inclusive desregistrado) dá 409 `signing-key-in-use`;
  - consulta de status com assinatura inválida dá 404 uniforme;
  - reivindicação: código errado ou vencido dá `claim-code-invalid`; a reivindicação vincula a organização
    pessoal, dá `hub_owner` ao dono e `hub_room` à Sala, e audita;
  - duas reivindicações concorrentes do mesmo código: uma vence;
  - desafio de Hub inexistente parece válido e nunca valida; desafio reusado é recusado; Hub desregistrado é
    recusado; o token tem `typ` de Hub; o `last_seen_at` é atualizado;
  - o guard de Hub recusa token de usuário e o guard de usuário recusa token de Hub.
- [ ] Commitar `feat(hubs): enrollment, claim and hub authentication`.

### Task 7: Vínculos, espaços no Hub, Sala, papéis e desregistro
**Files:** `src/hubs/application/*` (casos de uso da spec §7, menos a sincronização), `hub-access.ts` (exportado),
os ganchos inscritos (`MemberRemovedHooks` e `SpaceMemberLeftHooks`) e as specs.
- [ ] Testes de cada regra da spec §4 e §6:
  - **vínculos:**
    - o dono vincula com `any_member_hub` e o vínculo nasce aprovado; com `admin_approved` fica pendente e um admin
      aprova;
    - pedido por código de vínculo: código inválido dá `link-code-invalid`; a pessoa precisa ser membro da
      organização; o dono aprova e, se a política exigir, um admin também;
    - recusar funciona;
    - desvincular (pelo dono ou por um admin) tira os espaços da organização do Hub, a Sala e as cópias, marca a
      troca pendente e tira os papéis de Hub de quem ficou sem organização vinculada;
  - **espaços no Hub:** o dono, sendo membro do espaço, pode pôr; um Gestor de organização vinculada pode pôr; um
    estranho recebe 404/403; só um espaço de organização vinculada e aprovada pode entrar;
  - **Sala:** com `allowRoomSpaces = false` dá 422 `room-not-allowed`; quem não é Gestor recebe 403;
  - **papéis de Hub:** atribuir funciona; o dono protegido dá 422;
  - **desregistrar:** cascata completa;
  - **ganchos:** o dono sai do espaço e a Sala cai; a pessoa sai da organização e o papel de Hub cai;
  - **atomicidade:** falha desfaz tudo.
- [ ] Commitar `feat(hubs): organization links, hub spaces, room and roles`.

### Task 8: Sincronização do Hub
**Files:** `src/hubs/application/sync-hub.use-case.ts` (com spec), o repositório de leitura de sync (infra, com
consultas por tipo) e `test/hubs/sync.e2e-spec.ts`.
- [ ] Testes:
  - `since=0` traz tudo do escopo, em ordem;
  - a paginação por `nextSince` não perde nem repete itens;
  - membro traz o material trancado e não traz `authHash`;
  - organização sem vínculo aprovado não aparece;
  - desvincular faz o vínculo voltar como lápide;
  - espaço fora de `hub_space` não aparece;
  - a cópia de outro Hub não aparece;
  - lápide de cópia ou de papel aparece;
  - limite de 500.
- [ ] Commitar `feat(hubs): hub sync over HTTP`.

### Task 9: HTTP e e2e de ponta a ponta
**Files:** `src/hubs/infra/http/{hub-enrollments,hub-auth,hubs,hub-organizations,hub-spaces,hub-sync}.controller.ts`,
os DTOs, os rate limits (decisão 10) e `test/hubs/*.e2e-spec.ts`. `test/support/` ganha um cliente de Hub (gera as
chaves, apresenta, autentica e sincroniza).
- [ ] e2e com a cripto real do Hub e do cliente:
  - **fluxo do aparelho:** o fluxo completo da spec §4, ponta a ponta: apresenta, consulta o status, reivindica,
    autentica, vincula, põe espaço, libera na Sala, sincroniza, e o Hub abre a cópia da chave com a chave privada
    dele;
  - **troca de chave com a Sala:** só passa com a cópia do Hub; depois de desvincular, o Hub não recebe a versão
    nova;
  - **pedido de vínculo:** pedido por código de vínculo com dois consentimentos;
  - **Review Focus 1–5;**
  - **rate limits** das rotas do Hub;
  - **documentação:** o Swagger público continua sem rotas de Hub.
- [ ] Commitar `feat(hubs): hubs endpoints`.

### Task 10: Documentação e verificação final
- [ ] `CLAUDE.md`:
  - o módulo `hubs` (dependências, `HubAccess`, identidade e token de Hub, Sala e troca de chave, ganchos,
    sincronização, rate limits, variáveis novas);
  - as pendências: WebSocket, apagamento remoto, transferência, admin tirando todas as Salas da organização,
    limpeza de apresentações, códigos e desafios vencidos.
- [ ] Status da spec "aprovada em 01/11/2026 (implementada)".
- [ ] A verificação completa e o CI verde. Commitar `docs: document hubs module`.
