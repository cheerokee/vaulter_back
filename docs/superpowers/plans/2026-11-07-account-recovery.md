# Recuperação de conta — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recuperar a conta com e-mail + código de recuperação pessoal (obrigatório no cadastro), mantendo o mesmo par de chaves, e permitir trocar o código.

**Architecture:** Tudo no módulo `identity`. O app tranca uma segunda cópia da chave privada com uma chave derivada do código e manda uma prova de posse; o servidor guarda a cópia e um hash BLAKE2b com chave da prova (sem Argon2id, sem pool). Duas rotas públicas sem estado (`lookup` devolve a cópia; `complete` grava a senha nova, revoga todas as sessões e abre uma nova) e uma autenticada (`PUT /me/recovery-code`).

**Tech Stack:** NestJS 12, TypeScript 6 (ESM, imports `.js`), TypeORM 1.x + Postgres 18, libsodium (`getSodium()`), Vitest + supertest, `@nestjs/throttler`.

**Spec:** `docs/superpowers/specs/2026-11-07-account-recovery-design.md` (leia junto; este plano argumenta a partir dela).

## Global Constraints

- Código pt-BR nos docs, inglês no código/logs/commits (Conventional Commits). Tudo na `develop`; push depois de cada commit.
- Imports relativos com `.js`; Vitest (globais); oxlint `no-floating-promises`; Prettier.
- Domínio puro (sem `@nestjs/*`/`typeorm`); erros de `src/shared/domain/errors.ts`; validação de formato só nos DTOs.
- Rótulos de contexto/AD **sem o nome do produto**. Todo blob começa com byte de versão `0x01`. base64url sem padding.
- O código de recuperação (32 bytes) **nunca** chega ao servidor; `recoveryProof`, `recoveryEncryptedPrivateKey` e `recoveryHash` nunca saem em log, Sentry, `GET /me`, sincronização do Hub nem resposta (exceto a cópia em `lookup`).
- Mesmo erro para toda falha de recuperação: `UnauthenticatedError('recovery-failed', 'Invalid e-mail or recovery code.')` → 401.
- Colunas `NOT NULL`, corte direto (o banco de dev tem zero usuários; nenhum cliente chama `/auth/register`).
- Antes de cada commit de código: `npm run build && npm test && npm run lint && npm run typecheck`; nas tarefas que mexem em banco/HTTP também `docker exec vaulter-back-app npm run test:e2e` (e `migration:run` + `schema:check` na Task 3).

## Review Focus

1. **E-mail com maiúsculas/espaços** na recuperação: tem de achar a conta como o login (`normalizeEmail`). → teste na Task 4.
2. **Material novo inválido com prova válida** (`complete` com `kdfParams` ruim): 422 **antes** de olhar a conta (não vira oráculo de prova certa) e nada muda (sessões continuam vivas). → teste na Task 4.
3. **Refresh token antigo depois da recuperação**: 401 (sessão revogada com `account_recovery`), inclusive a sessão de quem pediu. → teste na Task 4.
4. **Prova bem formada mas errada × e-mail inexistente × prova de tamanho errado**: o mesmo 401 `recovery-failed`. → teste na Task 4.
5. **Troca de senha comum depois de criar o código**: o código continua abrindo a conta (a cópia tranca a mesma chave privada). → teste na Task 5.

---

### Task 1: Contrato cripto do código de recuperação

**Files:**
- Modify: `docs/crypto/user-keys.md` (nova seção "Código de recuperação (v1)"; reescrever o item "Recuperação de senha por e-mail" de "Fluxos")
- Modify: `test/support/client-crypto.ts`
- Test: `test/support/client-crypto.spec.ts`

**Interfaces:**
- Produces (em `test/support/client-crypto.ts`):
  - `RECOVERY_CONTEXT = 'acctrcvy'`; `RECOVERY_AD = 0x01 ‖ ASCII "recovery"` (9 bytes).
  - `deriveRecoveryKeys(code: Uint8Array): Promise<{ recoveryProof: Uint8Array; encKey: Uint8Array }>` — `crypto_kdf_derive_from_key(32, 1 | 2, 'acctrcvy', code)`.
  - `sealPrivateKeyForRecovery(privateKey: Uint8Array, encKey: Uint8Array, nonce: Uint8Array): Promise<Uint8Array>` — 73 bytes `0x01 ‖ nonce ‖ AEAD(privateKey, ad = RECOVERY_AD)`.
  - `createRecoveryMaterial(privateKey: Uint8Array): Promise<{ recoveryCode: Uint8Array; recoveryProof: string; recoveryEncryptedPrivateKey: string }>` (código aleatório de 32 bytes).
  - `openRecoveryPrivateKey(code: Uint8Array, recoveryEncryptedPrivateKey: string): Promise<Uint8Array>`.
  - `ClientAccount` ganha `recoveryCode: Uint8Array; recoveryProof: string; recoveryEncryptedPrivateKey: string`, preenchidos por `createClientAccount`.

- [ ] **Step 1: Testes que falham em `client-crypto.spec.ts`**
  - `it('derives the recovery proof and seals the private key per the v1 recovery vector')`: código = bytes `0x00..0x1f`, privada = bytes `0x20..0x3f`, nonce = 24 bytes `0x40..0x57`; espera `recoveryProof` e o blob iguais aos valores do vetor do `user-keys.md` (os valores são calculados uma vez no Step 3 e colados no doc e no teste).
  - `it('opens the recovery copy back to the same private key')`: `createClientAccount('pw')` → `openRecoveryPrivateKey(acc.recoveryCode, acc.recoveryEncryptedPrivateKey)` igual a `acc.privateKey`.
  - `it('never opens the password blob with the recovery key (different AD)')`: tentar abrir `encryptedPrivateKey` trocando a chave pela `encKey` da recuperação **e** abrir a cópia da recuperação com `ad = 0x01` → ambos lançam.
- [ ] **Step 2:** `npx vitest run test/support/client-crypto.spec.ts` → FAIL (funções inexistentes).
- [ ] **Step 3:** Implementar as funções acima; calcular o vetor (script de uma vez, fora do repo) e escrever no `user-keys.md` a seção nova: código = 32 bytes aleatórios (a forma de mostrar é do app), contexto `acctrcvy` (ids 1 = `recoveryProof`, 2 = chave de cifra), sem Argon2id (256 bits de entropia), blob de 73 bytes com `ad = 0x01 ‖ "recovery"`, tabela de tamanhos (`recoveryProof` 32 B/43 chars, `recoveryEncryptedPrivateKey` 73 B/98 chars), vetor de teste, fluxos (cadastro obrigatório, recuperar em dois passos, trocar código; troca de senha não muda o código). Trocar o item "Recuperação de senha por e-mail" por: recuperação pelo código devolve login **e** dados; sem código, quem está sozinho perde o que está cifrado.
- [ ] **Step 4:** `npx vitest run test/support/client-crypto.spec.ts` → PASS.
- [ ] **Step 5: Commit** `docs(crypto): v1 account recovery code format` (doc + helpers + spec).

### Task 2: Domínio, hasher da prova e variável de ambiente

**Files:**
- Modify: `src/identity/domain/crypto-material.ts`, `src/identity/domain/user.ts`, `src/identity/domain/user.spec.ts`
- Create: `src/identity/application/ports/recovery-proof-hasher.ts`, `src/identity/infra/crypto/sodium-recovery-proof-hasher.ts`, `src/identity/infra/crypto/sodium-recovery-proof-hasher.spec.ts`
- Modify: `src/identity/identity.module.ts`, `src/shared/infra/config/env.validation.ts` (+ `.spec.ts`), `.env.example`, `.github/workflows/ci.yml`, `.env` local (não versionado), `src/shared/infra/observability/sensitive-fields.ts`

**Interfaces:**
- Produces:
  - `assertRecoveryProof(s: string): string` (32 bytes, erro `recovery-proof-invalid`) e `assertRecoveryEncryptedPrivateKey(s: string): string` (73 bytes, `b[0] === 0x01`, erro `recovery-encrypted-private-key-invalid`).
  - `UserProps` ganha `recoveryHash: string; recoveryEncryptedPrivateKey: string`; `User.register` e `User.validateRegistration` recebem `recoveryEncryptedPrivateKey` (e `register` também `recoveryHash`, validado não vazio como `authHash`, erro `recovery-hash-invalid`); getters `recoveryHash`, `recoveryEncryptedPrivateKey`.
  - `user.changeRecoveryCode(input: { recoveryHash: string; recoveryEncryptedPrivateKey: string }): void`.
  - `abstract class RecoveryProofHasher { abstract hash(proof: string): string; abstract verify(storedHash: string, proof: string): boolean; abstract verifyAgainstDummy(proof: string): void }` — síncrono (BLAKE2b é barato).
  - `SodiumRecoveryProofHasher` (`OnModuleInit` decodifica `IDENTITY_RECOVERY_HASH_KEY`, como `SodiumHubCodeHasher`): `crypto_generichash(32, 'account-recovery-proof-v1\0' + proof, key)` em hex (64 chars); `verify` compara com `sodium.memcmp` (tempo constante); `verifyAgainstDummy` faz o mesmo trabalho contra um hash fixo.
  - Env `IDENTITY_RECOVERY_HASH_KEY` obrigatória, `@Matches(BASE64URL_32_BYTES)`.
- [ ] **Step 1: Testes que falham**
  - `crypto-material` (em `user.spec.ts` ou spec próprio): `assertRecoveryProof` aceita 43 chars válidos e recusa 42/44 chars e padding; `assertRecoveryEncryptedPrivateKey` recusa versão `0x02`.
  - `user.spec.ts`: `register` sem `recoveryEncryptedPrivateKey` válido lança `recovery-encrypted-private-key-invalid`; `recoveryHash: ''` lança `recovery-hash-invalid`; `changeRecoveryCode` troca os dois campos e não toca `encryptedPrivateKey`/`authHash`.
  - `sodium-recovery-proof-hasher.spec.ts`: `verify(hash(p), p) === true`; `verify(hash(p), q) === false`; o hash tem 64 chars hex e muda com outra chave; `verifyAgainstDummy` não lança.
  - `env.validation.spec.ts`: falta ou valor de 42 chars em `IDENTITY_RECOVERY_HASH_KEY` → erro.
- [ ] **Step 2:** `npm test` → FAIL nesses testes.
- [ ] **Step 3:** Implementar; registrar `{ provide: RecoveryProofHasher, useClass: SodiumRecoveryProofHasher }` no `IdentityModule`; chave nova no `.env.example` (valor de dev gerado com `randomBytes(32).toString('base64url')`), no `env` do `ci.yml` e no `.env` local; acrescentar a `BASE_KEYS`: `recoveryProof`, `newRecoveryProof`, `recoveryEncryptedPrivateKey`, `newRecoveryEncryptedPrivateKey`, `recoveryHash`. Corrigir os `User.register` dos specs unitários existentes (passar os dois campos novos).
- [ ] **Step 4:** `npm run build && npm test && npm run lint && npm run typecheck` → verde.
- [ ] **Step 5: Commit** `feat(identity): recovery code domain and proof hasher`.

### Task 3: Persistência, motivo de revogação e cadastro obrigatório

**Files:**
- Modify: `src/identity/infra/db/user.entity.ts`, `user.mapper.ts`, `user-session.entity.ts` (CHECK), `src/identity/domain/session.ts` (`SessionRevokedReason`)
- Create: `src/database/migrations/1792895500000-AddUserAccountRecovery.ts`
- Modify: `src/identity/application/register-user.use-case.ts` (+ spec), `src/identity/infra/http/dto/register.dto.ts`, `src/identity/infra/http/auth.controller.ts`
- Modify: `test/support/identity-client.ts` (`registerBody`), e todo `User.register(` em `test/**` (`test/identity/repositories.e2e-spec.ts`, `test/hubs/repositories.e2e-spec.ts`, `test/shared/unit-of-work.e2e-spec.ts`, `test/organizations/repositories.e2e-spec.ts`, `test/spaces/repositories.e2e-spec.ts`)
- Test: `test/identity/auth.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 1 (`ClientAccount.recoveryProof`/`recoveryEncryptedPrivateKey`), Task 2 (`RecoveryProofHasher`, `User.register` com campos novos).
- Produces: colunas `users.recovery_hash varchar(64) NOT NULL` e `users.recovery_encrypted_private_key text NOT NULL`; `SessionRevokedReason` inclui `'account_recovery'` (CHECK de `user_sessions.revoked_reason` idem); `RegisterUserInput` ganha `recoveryProof: string; recoveryEncryptedPrivateKey: string`; `RegisterDto` ganha os dois campos (`@IsString() @Matches(BASE64URL) @MaxLength(256)`).
- [ ] **Step 1: Testes que falham**
  - `register-user.use-case.spec.ts`: `recoveryProof` malformada lança `recovery-proof-invalid` **antes** do hash Argon2 (`hasher.hash` não chamado); sucesso grava `recoveryHash === recoveryHasher.hash(proof)` no usuário criado.
  - `auth.e2e-spec.ts`: `it('rejects a registration without the recovery material')` → 422 sem `recoveryProof` e sem `recoveryEncryptedPrivateKey`; `it('stores only the hash of the recovery proof')` → linha de `users` tem `recovery_hash` ≠ prova e `recovery_encrypted_private_key` = a enviada.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** Entidade + mapper; migration manual (`up`: `ADD COLUMN` das duas, `DROP`/`ADD CONSTRAINT ck_user_sessions_revoked_reason` com `'account_recovery'`; `down` inverso); caso de uso valida `assertRecoveryProof` junto com `assertAuthProof` e passa `recoveryHash` a `User.register`; controller repassa; `registerBody` manda `account.recoveryProof`/`account.recoveryEncryptedPrivateKey`; specs e2e com `User.register` passam material válido (um helper local por spec ou um export em `test/support/client-crypto.ts`, `testRecoveryFields()` → `{ recoveryHash: 'x'.repeat(64), recoveryEncryptedPrivateKey }` com um blob válido fixo).
- [ ] **Step 4:** dentro do container: `npm run migration:run && npm run schema:check`, depois `npm run build && npm test && npm run lint && npm run typecheck` e `npm run test:e2e` → verde.
- [ ] **Step 5: Commit** `feat(identity): require recovery material at registration`.

### Task 4: Recuperar a conta (`lookup` + `complete`)

**Files:**
- Create: `src/identity/application/lookup-recovery.use-case.ts` (+ spec), `src/identity/application/complete-recovery.use-case.ts` (+ spec), `src/identity/infra/http/dto/recovery.dto.ts`
- Modify: `src/identity/infra/http/auth.controller.ts`, `src/identity/identity.module.ts`, `src/shared/infra/http/rate-limits.ts`
- Test: `test/identity/recovery.e2e-spec.ts` (novo), `test/shared/rate-limit.e2e-spec.ts`, `test/hubs/sync.e2e-spec.ts`, `test/identity/me.e2e-spec.ts`
- Modify: `test/support/identity-client.ts` (helpers `recoveryLookup(email, proof)`, `recoveryComplete(body)`)

**Interfaces:**
- Consumes: Task 2 (`RecoveryProofHasher`, `assertRecoveryProof`), Task 3 (`'account_recovery'`), existentes `UserRepository.findByEmail`, `User.validatePasswordChange`, `user.changePassword`, `AuthProofHasher.hash`, `SessionRepository.revokeAllForUser`, `SessionIssuer.start`, `toLoginResult`, `UnitOfWork.run`, `loginEmailTracker`.
- Produces:
  - `LookupRecoveryUseCase.execute(input: { email: string; recoveryProof: string }): Promise<{ recoveryEncryptedPrivateKey: string }>` — `POST /auth/recovery/lookup`, 200.
  - `CompleteRecoveryUseCase.execute(input: { email: string; recoveryProof: string; newAuthProof: string; newKdfSalt: string; newKdfParams: unknown; newEncryptedPrivateKey: string; device: DeviceInput; client: ClientInfo }): Promise<LoginResult>` — `POST /auth/recovery/complete`, 200, mesma resposta do login (`LoginResponse.from`).
  - `RATE_LIMITS.accountRecoveryIp = { limit: 10, ttl: MINUTE }`; `THROTTLE_GROUPS.accountRecovery = { name: 'account-recovery', ...RATE_LIMITS.accountRecoveryIp }`. As duas rotas: `@Public()`, `@ThrottleGroup(THROTTLE_GROUPS.accountRecovery)` e `@ThrottleByEmail(loginEmailTracker)` (5/min por e-mail, por rota).
- Regras:
  - Verificação comum (helper privado ou função no mesmo arquivo dos dois casos de uso): e-mail não string/inexistente ou prova malformada → `verifyAgainstDummy` e `recovery-failed`; `verify` falso → `recovery-failed`.
  - `complete` valida **primeiro** o material novo (`assertAuthProof(newAuthProof)`, `User.validatePasswordChange`, `assertDevice`) — 422 independente da conta —, depois a prova, depois `authHasher.hash(newAuthProof)`, e então num `uow.run`: `user.changePassword(...)`, `users.save`, `sessions.revokeAllForUser(user.id, 'account_recovery', now)` (sem exceção), `sessionIssuer.start(...)`.
  - Log estruturado depois do `run`: Nest `Logger` com `{ event: 'account.recovered', userId }` (nada de prova/blob).
- [ ] **Step 1: Testes unitários que falham** (contratos simulados via `vi`): lookup devolve a cópia com prova certa; e-mail inexistente chama `verifyAgainstDummy` e lança `recovery-failed`; prova de 42 chars → `recovery-failed` (não 422); complete com `newKdfParams` inválido lança `DomainValidationError` **sem** chamar `users.findByEmail`; complete com prova errada não chama `authHasher.hash`; complete feliz chama `revokeAllForUser(userId, 'account_recovery', now)` antes de `sessionIssuer.start`.
- [ ] **Step 2: e2e que falham em `test/identity/recovery.e2e-spec.ts`** (cripto real, `createClientAccount`):
  - `it('recovers the account with the code and keeps the same key pair')`: cadastra; lookup com e-mail em maiúsculas e com espaços (Review Focus 1) → abre a cópia com `openRecoveryPrivateKey` = privada original; monta senha nova com `rewrapPrivateKey`; complete → 200 com `keys.publicKey` igual ao do cadastro; login com a senha nova → 200; com a antiga → 401 `invalid-credentials`.
  - `it('revokes every session, including the old refresh tokens')` (Review Focus 3): duas sessões antes; depois do complete, `POST /auth/refresh` com os dois refresh antigos → 401; o access token antigo em `GET /me` → 401.
  - `it('answers the same 401 for unknown e-mail, wrong proof and wrong-size proof')` (Review Focus 4): três chamadas de lookup e três de complete → todas 401 com `type` terminando em `recovery-failed` e o mesmo `detail`.
  - `it('rejects invalid new material with 422 before checking the proof and changes nothing')` (Review Focus 2): complete com prova certa e `newKdfParams: {}` → 422; com prova **errada** e o mesmo material → também 422; a sessão anterior continua válida (`GET /me` 200).
  - `it('keeps an open space readable after recovery')`: cria espaço com `c.spaces`, recupera, abre a cópia do espaço com a privada recuperada.
- [ ] **Step 3: e2e de vazamento e limite**
  - `me.e2e-spec.ts`: o corpo de `GET /me` não tem nenhuma chave contendo `recovery` (busca recursiva no JSON).
  - `sync.e2e-spec.ts`: nenhum item `member` da sincronização tem chave contendo `recovery` em `data`.
  - `rate-limit.e2e-spec.ts`: `it('shares one per-IP budget between recovery lookup and complete')` → 10 pedidos alternados passam (401), o 11º dá 429 com `Retry-After`; e o 6º lookup para o mesmo e-mail (de IPs diferentes via `X-Forwarded-For` com `TRUST_PROXY` do teste, como o teste de login faz) dá 429.
- [ ] **Step 4:** Implementar casos de uso, DTOs (`RecoveryLookupDto { email; recoveryProof }`, `RecoveryCompleteDto` = campos do `ChangePasswordDto` sem `currentAuthProof` + `email`, `recoveryProof`, `device`; `RecoveryLookupResponse { recoveryEncryptedPrivateKey }`, decorators de Swagger como os vizinhos), rotas e limites; registrar no módulo.
- [ ] **Step 5:** `npm run build && npm test && npm run lint && npm run typecheck` e `docker exec vaulter-back-app npm run test:e2e` → verde.
- [ ] **Step 6: Commit** `feat(identity): account recovery with the recovery code`.

### Task 5: Trocar o código (`PUT /me/recovery-code`)

**Files:**
- Create: `src/identity/application/change-recovery-code.use-case.ts` (+ spec), `src/identity/infra/http/dto/change-recovery-code.dto.ts`
- Modify: `src/identity/infra/http/me.controller.ts`, `src/identity/identity.module.ts`, `src/shared/infra/http/rate-limits.ts` (comentário de `reauth` lista a rota nova)
- Test: `test/identity/recovery.e2e-spec.ts`

**Interfaces:**
- Consumes: `CurrentAuthProofVerifier.verify(userId, proof)`, `RecoveryProofHasher.hash`, `user.changeRecoveryCode`, `assertRecoveryProof`, `assertRecoveryEncryptedPrivateKey`.
- Produces: `ChangeRecoveryCodeUseCase.execute(auth: Actor, input: { currentAuthProof: string; newRecoveryProof: string; newRecoveryEncryptedPrivateKey: string }): Promise<void>` — `PUT /me/recovery-code`, 204, `@ThrottleReauth()`. Não revoga sessões. Log `{ event: 'account.recovery_code_changed', userId }`.
- [ ] **Step 1: Testes que falham**
  - unitário: prova atual errada → lança (do `CurrentAuthProofVerifier`) e não salva; material novo malformado → `DomainValidationError` sem salvar; feliz → `users.save` com `recoveryHash = hash(newProof)`.
  - e2e `it('replaces the recovery code: the old one stops working, the new one recovers')`: troca; lookup com a prova antiga → 401 `recovery-failed`; com a nova → 200 e abre com o código novo; as sessões continuam válidas.
  - e2e `it('keeps the recovery code valid after a password change')` (Review Focus 5): `PUT /me/password`; lookup com o código do cadastro → 200 e abre a mesma privada.
  - e2e: `PUT /me/recovery-code` com `currentAuthProof` errada → 401 e conta no orçamento `reauth` (6ª tentativa entre `/me/password` e `/me/recovery-code` → 429, no `rate-limit.e2e-spec.ts`).
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** Implementar (ordem como `ChangePasswordUseCase`: reautenticação primeiro, depois validar, depois gravar).
- [ ] **Step 4:** `npm run build && npm test && npm run lint && npm run typecheck` e `docker exec vaulter-back-app npm run test:e2e` → verde.
- [ ] **Step 5: Commit** `feat(identity): change the recovery code`.

### Task 6: Documentação viva e fechamento

**Files:**
- Modify: `CLAUDE.md` (módulo `identity`: recuperação pelo código, formato em `docs/crypto/user-keys.md`; tabela de rate limit: as duas rotas de recuperação e `PUT /me/recovery-code` no orçamento `reauth`; tabela de variáveis: `IDENTITY_RECOVERY_HASH_KEY`; "Rotação de segredos": trocar a chave invalida **todos** os códigos, então não se troca sem um plano de recadastro dos códigos; "Pendências antes de produção": confirmação por e-mail, aviso e auditoria visível da recuperação), `docs/superpowers/specs/2026-11-07-account-recovery-design.md` (status: implementada)
- [ ] **Step 1:** Atualizar os docs acima.
- [ ] **Step 2:** Verificação completa: `npm run build && npm test && npm run lint && npm run typecheck`; no container `npm run migration:show`, `npm run schema:check`, `npm run test:e2e` → tudo verde.
- [ ] **Step 3: Commit** `docs: document account recovery` e push; conferir o CI da `develop` verde.
