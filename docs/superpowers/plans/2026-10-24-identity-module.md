# Fundação compartilhada + módulo `identity` — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar a fundação compartilhada do backend (`src/shared/`) e o primeiro módulo, `identity`: cadastro
e login com prova derivada da senha, sessões por aparelho com refresh rotativo, `/me` e troca de senha. Ele
também serve de módulo de referência para os próximos.

**Architecture:** Monólito modular NestJS, com as camadas `domain` / `application` / `infra` dentro de cada
módulo (CLAUDE.md, "Arquitetura"). O backend não cifra nada: guarda os blobs do usuário, valida formato e
tamanho, faz hash da prova de login (Argon2id via libsodium) e assina tokens de acesso JWT EdDSA. A sessão
fica na tabela `user_sessions`, consultada a cada requisição, e por isso revogar vale na hora.

**Tech Stack:** NestJS 12, TypeScript 6 (ESM), TypeORM 1 + PostgreSQL 18, Vitest + supertest,
`libsodium-wrappers-sumo` 0.8, `jose` 6, `class-validator`/`class-transformer`, `@nestjs/swagger` 12,
`nestjs-pino` 5 + `pino-http` 11, `@sentry/nestjs` 11, `uuid` 14.

**Spec:** `CLAUDE.md` (decisões transversais, arquitetura, banco, observabilidade, documentação),
`docs/der_model.sql` e `../valter-valt-ai/docs/superpowers/specs/2026-10-24-organizacoes-espacos-e-nuvem-design.md`
(§5, §5.0, §7.2, §12), além do pedido do Jonas de 24/10/2026, que fixa o escopo das Fases 0 e 1.

## Decisões fechadas com o Jonas neste plano (24/10/2026)
- **Token de acesso:** JWT **EdDSA (Ed25519)**, com `iss` vindo do `.env`, `sub` = userId, `sid` = sessionId e
  `kid` no cabeçalho, válido por 15 min. A cada requisição o backend confere a assinatura **e** consulta a
  sessão no banco (busca por PK), e assim a revogação vale na hora. Mais tarde o Hub pode validar o token
  offline com a chave pública.
- **Refresh:** rotativo, com **30 dias de inatividade** (cada refresh renova o prazo) e sem teto absoluto.
  Os dois prazos ficam configuráveis no `.env`.
- **Troca de senha:** revoga todas as outras sessões do usuário (motivo `password_change`).
- **Tabela nova `user_sessions`** no DER (`.sql` **e** `.mwb`). Não é sincronizável, então não tem
  `sync_version`.

## Decisões técnicas deste plano (revisáveis; registradas em `docs/` e no CLAUDE.md ao final)
1. **Codificação de binários na API:** base64url **sem padding** (a variante `URLSAFE_NO_PADDING` da
   libsodium).
2. **Material do usuário (formato v1)**, que o app e o Hub precisam seguir. Fica documentado em
   `docs/crypto/user-keys.md`:
   - `kdfSalt`: 16 bytes (`crypto_pwhash_SALTBYTES`), ou seja, 22 caracteres;
   - `kdfParams`: `{ "algorithm": "argon2id13", "opsLimit": int, "memLimitBytes": int }`, sem outras chaves.
     Faixa aceita: `opsLimit` de 2 a 10 e `memLimitBytes` de 64 MiB a 1 GiB (`67108864`–`1073741824`).
     Padrão: `opsLimit` 3 e `memLimitBytes` 67108864. O salt falso do pré-login usa esse padrão;
   - chave mestra = `crypto_pwhash(32, senha, kdfSalt, opsLimit, memLimitBytes, ALG_ARGON2ID13)`;
   - `authProof` = `crypto_kdf_derive_from_key(32, 1, "acctkeys", chaveMestra)` (32 bytes, 43 caracteres);
   - chave de cifra = `crypto_kdf_derive_from_key(32, 2, "acctkeys", chaveMestra)`. Ela nunca sai do
     aparelho. O contexto `"acctkeys"` não leva o nome do produto;
   - `publicKey`: chave pública X25519 crua, 32 bytes (43 caracteres);
   - `encryptedPrivateKey` = `0x01 ‖ nonce(24) ‖ crypto_aead_xchacha20poly1305_ietf_encrypt(privateKey(32), ad = 0x01, nonce, chaveDeCifra)`,
     num total de **73 bytes** (98 caracteres). O primeiro byte é a versão do formato.
3. **Hash da prova no servidor:** `crypto_pwhash_str` (Argon2id) com `opsLimit` 2 e `memLimit` 19 MiB
   (19922944), o mínimo da OWASP. O resultado cabe em `auth_hash VARCHAR(255)`. Quando o e-mail não existe,
   o login roda uma verificação falsa contra um hash fixo, para igualar o tempo de resposta.
4. **Salt falso do pré-login:** `crypto_generichash(16, emailNormalizado, IDENTITY_DECOY_SALT_KEY)`. É
   determinístico por e-mail e muda de um e-mail para outro.
5. **E-mail:** normalizado com `trim` e caixa baixa antes de qualquer uso. Fica sob um índice único parcial
   (`WHERE deleted_at IS NULL`). Cadastrar um e-mail já existente responde 409. Isso revela que a conta
   existe, limite aceito até haver confirmação de e-mail, o mesmo que fazem os gerenciadores de senha.
6. **Refresh token:** `<sessionId>.<segredo>`, com o segredo de 32 bytes aleatórios em base64url. O banco
   guarda `refresh_token_hash` = hex de `crypto_generichash(32, segredo)`. Basta um hash rápido porque o
   segredo tem 256 bits de entropia. A rotação é um `UPDATE ... WHERE id = $1 AND refresh_token_hash = $old
   AND revoked_at IS NULL`. Se nenhuma linha for afetada, o token conta como **reuso** e a sessão é
   revogada (`refresh_reuse`). Dois refreshes simultâneos com o mesmo token derrubam a sessão, então o
   cliente deve serializar os refreshes (fica no guia do protocolo).
7. **Erro novo `UnauthenticatedError` → 401**, para credencial inválida e token inválido ou expirado. A tabela
   de erros do CLAUDE.md ganha essa linha. Senha atual errada na troca de senha responde **422**
   (`current-auth-proof-invalid`), para não confundir o app, que trata 401 como sessão perdida.
8. **RLS que funciona de verdade:** superusuário e dono da tabela sem `FORCE` ignoram RLS. Por isso a app
   passa a conectar com um **papel de runtime sem superusuário** (`DB_APP_USERNAME`, padrão `vaulter_app`),
   membro de um papel de grupo `app_runtime` `NOLOGIN NOBYPASSRLS`. As permissões ficam nas migrations,
   concedidas a `app_runtime`: `SELECT, INSERT, UPDATE`, **sem `DELETE`**, o que reforça a regra de não
   apagar fisicamente. A rotina de limpeza das lápides decide isso mais tarde. A credencial fica fora das
   migrations: um script de init cria o login. Migrations, CLI, compose e pgAdmin continuam com
   `DB_USERNAME` (o dono). O contexto da organização vai por transação, com
   `set_config('app.organization_id', $1, true)`. A policy usa
   `NULLIF(current_setting('app.organization_id', true), '')::uuid`, e sem contexto não aparece nenhuma
   linha.
9. **Enums do DER** viram `varchar` + `CHECK` no Postgres, porque alterar um enum nativo depois é caro.
10. **Rotas internas (do app/hub), sem a tag `public`:** `/auth/*`, `/sessions`, `/me`. O refresh token vai no
    corpo, sem cookie: não há front web na v1.
11. **Banco de teste:** os testes e2e rodam em `${DB_DATABASE}_test` (ou `DB_TEST_DATABASE`), que o
    `globalSetup` cria e migra. O banco de desenvolvimento nunca é truncado.

## Fora deste plano
Organizações (inclusive a pessoal no cadastro), espaços, hubs, permissões, e-mail de "esqueci a senha", API de
integração, endpoint de sincronização, rate limiting do login (`@nestjs/throttler`, que entra antes de
produção), JWKS público para o Hub e exclusão de conta (LGPD), que precisa revogar as sessões quando
existir.

## Global Constraints
- ESM puro: imports relativos com `.js`; Node >= 20 (o time usa 24).
- `domain/` não importa `@nestjs/*`, `typeorm` nem `infra/`. Um módulo não importa a `infra/` de outro. O
  que for preciso em vários módulos (decorators `@Public`/`@CurrentAuth`) fica em `src/shared/`.
- Casos de uso dependem de **classes abstratas** (tokens de DI), sem tokens em string nem `useFactory`.
- JSON em `camelCase`, banco em `snake_case` (via `SnakeNamingStrategy`), datas ISO 8601 UTC, paginação
  por cursor.
- Erros em `application/problem+json` (RFC 9457): `type`, `title`, `status`, `detail`, `requestId` e, em
  validação, `errors`. Stack e SQL nunca vão na resposta.
- IDs UUID v7. `synchronize: false` sempre. O schema só muda por migration, com `down` escrito.
- O nome do produto nunca aparece em código, tabelas, rotas nem rótulos de cripto. Emissor, título da
  documentação e base das URLs de erro vêm do `.env`.
- Nunca logar nem mandar ao Sentry: corpo de requisição, `Authorization`, `authProof*`, `authHash`,
  `encryptedPrivateKey*`, `kdfSalt*`, `kdfParams*`, `wrappedKey`, `accessToken`, `refreshToken`.
- Testes: Vitest. Unitários `*.spec.ts` ao lado do código, com contratos simulados via `vi`. Os e2e
  `test/**/*.e2e-spec.ts` rodam **dentro do container**:
  `docker exec vaulter-back-app npx vitest run --config vitest.config.e2e.ts <arquivo>`.
- Git: commits direto na `develop`, em Conventional Commits, com push para `origin/develop` logo após cada
  commit. Nunca usar `--force`.
- Definição de pronto: `npm run build && npm test && npm run lint && npm run test:e2e`, com o CI verde.

## Review Focus
1. **Refresh concorrente com o mesmo token:** só uma rotação vence; a outra é tratada como reuso e revoga a
   sessão. Nunca podem surgir dois refresh tokens válidos. (Task 11: integração; Task 16: e2e)
2. **Variações de caixa e espaços no e-mail:** cadastro com `" Ana@X.com "`, pré-login e login com
   `"ana@x.com"` acham a conta real, e um segundo cadastro com outra caixa dá 409. (Tasks 10, 16)
3. **Blobs malformados ou enormes** (base64 com padding, tamanho errado, byte de versão ≠ 0x01, `kdfParams`
   fora da faixa ou com chave extra, string de 1 MB): respondem 422 com a lista de campos, nunca 500.
   (Tasks 10, 16)
4. **Token de acesso inválido:** sessão revogada ou expirada, `alg: none`, outra chave, `exp` vencido ou
   `sid` de outro usuário: todos dão 401 `invalid-access-token`. (Tasks 12, 14, 16)
5. **Enumeração de contas:** pré-login de e-mail inexistente devolve sempre o mesmo salt para o mesmo e-mail,
   um salt diferente para outro e os `kdfParams` padrão. Login com e-mail inexistente devolve o **mesmo**
   `type` 401 que a prova errada. (Tasks 13, 16)

---

## Estrutura de arquivos

```
src/
  main.ts                                  # importa ./instrument.js primeiro; usa configureApp
  instrument.ts                            # Sentry.init (desligado sem DSN)
  app.module.ts                            # ConfigModule(validate), LoggerModule, SentryModule, DatabaseModule, IdentityModule
  database/
    typeorm.options.ts                     # typeOrmOptions(role: 'app' | 'migration')
    migrations/
      <ts>-SyncVersionInfrastructure.ts    # sequência + função de trigger
      <ts>-AppRuntimeRole.ts               # papel app_runtime + default privileges
      <ts>-CreateUsersAndSessions.ts
  shared/
    domain/
      entity.ts                            # Entity<TProps> com id v7
      id.ts                                # newId(), isUuidV7()
      errors.ts                            # DomainError e subclasses
      pagination.ts                        # CursorPageRequest, CursorPage, encode/decodeCursor
    infra/
      config/env.validation.ts             # validateEnv()
      crypto/sodium.ts                     # instância pronta da libsodium
      db/base.entity.ts                    # BaseTypeormEntity, SyncableTypeormEntity
      db/snake-naming.strategy.ts
      db/migration-helpers.ts              # addSyncVersionTrigger, enableOrganizationRls
      db/organization-scope.ts             # runInOrganizationScope, OrganizationScopedRepository
      http/configure-app.ts                # pipes, filtro, swagger, logger — usado por main e e2e
      http/problem-details.filter.ts
      http/request-validation.error.ts
      http/auth.decorators.ts              # @Public, @CurrentAuth, AuthContext
      http/cursor-pagination.query.ts
      http/swagger.ts                      # setupSwagger, filterPublicDocument
      observability/sensitive-fields.ts    # SENSITIVE_KEYS, scrubSensitive
      observability/logger.config.ts       # pinoHttpOptions()
      observability/sentry.config.ts       # sentryOptions()
  identity/
    domain/
      email.ts  kdf-params.ts  crypto-material.ts
      user.ts  user.repository.ts
      session.ts  session.repository.ts
    application/
      ports/auth-proof-hasher.ts  ports/access-token-service.ts  ports/refresh-token-codec.ts  ports/decoy-salt-factory.ts
      session-issuer.ts                    # cria sessão + emite par de tokens (usado por register/login)
      pre-login.use-case.ts  register-user.use-case.ts  login.use-case.ts
      authenticate-access-token.use-case.ts  refresh-session.use-case.ts  logout.use-case.ts
      list-sessions.use-case.ts  revoke-session.use-case.ts
      get-me.use-case.ts  change-password.use-case.ts
      dto/*.ts                             # LoginResult, SessionTokens, SessionView, UserView
    infra/
      crypto/sodium-auth-proof-hasher.ts  crypto/sodium-decoy-salt-factory.ts  crypto/sodium-refresh-token-codec.ts
      crypto/jose-access-token-service.ts
      db/user.entity.ts  db/user.mapper.ts  db/user.typeorm-repository.ts
      db/user-session.entity.ts  db/user-session.mapper.ts  db/user-session.typeorm-repository.ts
      http/auth.controller.ts  http/sessions.controller.ts  http/me.controller.ts
      http/access-token.guard.ts  http/dto/*.ts
    identity.module.ts
test/
  setup/global-setup.ts                    # cria/migra o banco de teste
  setup/test-app.ts                        # createTestApp(), resetDatabase(), adminDataSource()
  support/client-crypto.ts                 # lado do cliente simulado com libsodium
  shared/*.e2e-spec.ts  identity/*.e2e-spec.ts
docs/crypto/user-keys.md                   # protocolo do material do usuário (app/hub)
```

---

## Fase 0: fundação compartilhada

### Task 1: Dependências, configuração validada, papel de runtime do banco e banco de teste

**Files:**
- Modify: `package.json`, `.env.example`, `.env` (local do Jonas: só acrescentar as variáveis novas),
  `docker-compose.yaml` (nada muda no `db`, que segue com `DB_USERNAME` como dono), `.github/workflows/ci.yml`,
  `vitest.config.e2e.ts`, `src/database/typeorm.options.ts`, `src/database/data-source.ts`,
  `src/database/database.module.ts`, `src/app.module.ts`
- Create: `.docker/postgres/init/02-app-role.sh`, `src/shared/infra/config/env.validation.ts`,
  `src/database/migrations/<ts>-AppRuntimeRole.ts`, `test/setup/global-setup.ts`, `test/setup/test-app.ts`,
  `test/shared/database-role.e2e-spec.ts`, `src/shared/infra/config/env.validation.spec.ts`

**Interfaces:**
- Produces: `typeOrmOptions(role: 'app' | 'migration'): DataSourceOptions` (`app` usa `DB_APP_USERNAME`/
  `DB_APP_PASSWORD` e `migration` usa `DB_USERNAME`/`DB_PASSWORD`; os dois com
  `namingStrategy: new SnakeNamingStrategy()` da Task 2, adicionado lá); `validateEnv(config: Record<string, unknown>): EnvironmentVariables`;
  `createTestApp(): Promise<INestApplication>`; `resetDatabase(): Promise<void>` (faz `TRUNCATE ... CASCADE` em
  todas as tabelas, exceto `migrations`, usando o papel dono); `adminDataSource(): Promise<DataSource>` (papel dono,
  banco de teste).

- [ ] **Step 1: Instalar as dependências**

```bash
npm i @nestjs/swagger class-validator class-transformer nestjs-pino pino-http pino @sentry/nestjs libsodium-wrappers-sumo jose uuid
npm i -D @types/libsodium-wrappers-sumo pino-pretty
```
Confira se `import sodium from 'libsodium-wrappers-sumo'` funciona em ESM no Node 24. Se o pacote quebrar
em ESM, use `createRequire(import.meta.url)('libsodium-wrappers-sumo')` em `shared/infra/crypto/sodium.ts`
(Task 4 da Fase 1 depende disso; registre a escolha num comentário).

- [ ] **Step 2: Teste de `validateEnv`** (`env.validation.spec.ts`)
  - `it('rejects missing AUTH_JWT_SIGNING_SEED')`: espera que lance um erro citando `AUTH_JWT_SIGNING_SEED`;
  - `it('applies defaults')`: `AUTH_ACCESS_TOKEN_TTL_SECONDS` vira `900`, `AUTH_REFRESH_TOKEN_IDLE_DAYS`
    vira `30`, `API_DOCS_INTERNAL_ENABLED` vira `false` (seguro por padrão) e `LOG_LEVEL` vira `'info'`;
  - `it('rejects a signing seed that is not 32 bytes of base64url')`.

- [ ] **Step 3: Rodar e ver falhar** — `npx vitest run src/shared/infra/config` → FAIL (módulo inexistente).

- [ ] **Step 4: Implementar `validateEnv`** com `class-validator` (`plainToInstance` + `validateSync`) e
  ligar no `ConfigModule.forRoot({ isGlobal: true, validate: validateEnv })`. Variáveis novas (e no `.env.example`):

```
DB_APP_USERNAME=vaulter_app
DB_APP_PASSWORD=vaulter_app
DB_TEST_DATABASE=vaulter_test
PROBLEM_TYPE_BASE_URL=https://errors.example.invalid
API_DOCS_TITLE=API
API_DOCS_INTERNAL_ENABLED=true
LOG_LEVEL=info
LOG_PRETTY=true
SENTRY_DSN=
SENTRY_ENVIRONMENT=development
SENTRY_TRACES_SAMPLE_RATE=0
AUTH_JWT_ISSUER=http://localhost:3000
AUTH_JWT_KEY_ID=dev-1
AUTH_JWT_SIGNING_SEED=<gerar: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))">
AUTH_ACCESS_TOKEN_TTL_SECONDS=900
AUTH_REFRESH_TOKEN_IDLE_DAYS=30
IDENTITY_DECOY_SALT_KEY=<gerar igual>
```
No `.env.example`, os segredos levam valores de desenvolvimento fixos, com o comentário "só
desenvolvimento".

- [ ] **Step 5: Rodar e ver passar** — `npx vitest run src/shared/infra/config` → PASS.

- [ ] **Step 6: Papel de runtime.** A credencial fica com a infra e as permissões com as migrations:
  - `02-app-role.sh` é idempotente (`DO $$ ... IF NOT EXISTS`). Ele cria `app_runtime NOLOGIN NOBYPASSRLS`
    (se faltar), cria `${DB_APP_USERNAME}` `LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${DB_APP_PASSWORD}` (se
    faltar) e roda `GRANT app_runtime TO ${DB_APP_USERNAME}`. O compose passa
    `DB_APP_USERNAME`/`DB_APP_PASSWORD` ao serviço `db`. O **mesmo script** é chamado pelo `globalSetup`
    (via SQL equivalente) e por um passo do CI;
  - migration `AppRuntimeRole` (manual), sem nenhum nome de login dentro:
    - `up`: cria `app_runtime NOLOGIN NOBYPASSRLS` se faltar; faz
      `GRANT USAGE ON SCHEMA public TO app_runtime`;
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO app_runtime`;
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_runtime`;
    - `down`: revoga os default privileges (o papel fica, porque é do cluster).
  - Para o banco já existente do Jonas: o comando único
    `docker exec vaulter-back-db sh /docker-entrypoint-initdb.d/02-app-role.sh`, também documentado no
    CLAUDE.md.

- [ ] **Step 7: Banco de teste**
  - `vitest.config.e2e.ts`: carrega o `.env` (`process.loadEnvFile`, se existir), aponta
    `DB_DATABASE = DB_TEST_DATABASE ?? `${DB_DATABASE}_test`` e usa `globalSetup: './test/setup/global-setup.ts'`
    e `fileParallelism: false`;
  - `global-setup.ts`: conecta no banco `postgres` como dono, roda `CREATE DATABASE` se o banco não existir
    e `CREATE EXTENSION IF NOT EXISTS vector`, garante o login de runtime e o `GRANT app_runtime`, e roda as
    migrations de `src/database/migrations/*.ts` com um `DataSource` do papel `migration`;
  - CI: o job passa a definir `DB_APP_USERNAME`/`DB_APP_PASSWORD` e os segredos de teste, e ganha um passo
    `psql` que cria o login antes do `test:e2e`, como o script de init.

- [ ] **Step 8: Teste e2e do papel** (`test/shared/database-role.e2e-spec.ts`)
  - `it('app connects as a non-superuser role without BYPASSRLS')`: pelo `DataSource` da app,
    `SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user` devolve
    `vaulter_app`, `false`, `false`;
  - `it('app role cannot DELETE')`: como dono, cria a tabela `role_probe`; o `DELETE` feito pela app é
    rejeitado com o código `42501`.

- [ ] **Step 9: Rodar** — `docker exec vaulter-back-app npx vitest run --config vitest.config.e2e.ts test/shared/database-role.e2e-spec.ts` → PASS.
  O `test/app.e2e-spec.ts` existente continua passando (`npm run test:e2e`).

- [ ] **Step 10: Commit e push** — `feat(shared): validated env, app runtime db role and test database setup`

### Task 2: Base de domínio, IDs v7, paginação, entidade base TypeORM e `sync_version`

**Files:**
- Create: `src/shared/domain/{entity,id,pagination}.ts` + specs;
  `src/shared/infra/db/{base.entity,snake-naming.strategy,migration-helpers}.ts`;
  `src/database/migrations/<ts>-SyncVersionInfrastructure.ts`; `test/shared/sync-version.e2e-spec.ts`
- Modify: `src/database/typeorm.options.ts` (naming strategy)

**Interfaces:**
- Produces:
  - `newId(): string` (v7 via `uuid`); `isUuidV7(value: string): boolean`;
  - `abstract class Entity<TProps> { readonly id: string; protected props: TProps; protected constructor(props: TProps, id?: string) }`
    (gera o id quando ele não vem);
  - `interface CursorPageRequest { cursor?: string; limit: number }`;
    `interface CursorPage<T> { items: T[]; nextCursor: string | null }`;
    `encodeCursor(id: string): string` / `decodeCursor(cursor: string): string` (base64url do id; cursor
    inválido lança `DomainValidationError('invalid-cursor')`);
  - `src/shared/domain/errors.ts` nasce aqui (interface na Task 4); a Task 4 só acrescenta o filtro HTTP;
  - `abstract class BaseTypeormEntity { @PrimaryColumn('uuid') id; @CreateDateColumn({type:'timestamptz'}) createdAt; @UpdateDateColumn({type:'timestamptz', nullable:true}) updatedAt; @DeleteDateColumn({type:'timestamptz', nullable:true}) deletedAt }`;
  - `abstract class SyncableTypeormEntity extends BaseTypeormEntity { @Column({type:'bigint', insert:false, update:false}) syncVersion: string }`;
  - `addSyncVersionTrigger(qr: QueryRunner, table: string): Promise<void>` e `dropSyncVersionTrigger(...)`
    (coluna `sync_version bigint NOT NULL`, índice `ix_<table>_sync_version` e trigger
    `trg_<table>_sync_version BEFORE INSERT OR UPDATE ... EXECUTE FUNCTION set_sync_version()`);
  - `SnakeNamingStrategy` (propriedades camelCase viram colunas snake_case; nomes de tabela explícitos
    nas entidades).

- [ ] **Step 1: Testes unitários**
  - `id.spec.ts`: `newId()` passa em `isUuidV7`; dois ids gerados em sequência saem em ordem
    (`a < b`); `isUuidV7('…v4…')` é `false`;
  - `pagination.spec.ts`: `decodeCursor(encodeCursor(id)) === id`; `decodeCursor('%%%')` e o cursor de algo
    que não é UUID lançam erro;
  - `snake-naming.strategy.spec.ts`: `columnName('refreshTokenHash', undefined, [])` dá `'refresh_token_hash'`.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar** os arquivos acima.
- [ ] **Step 4: Migration `SyncVersionInfrastructure`** (manual):
  - `up`: `CREATE SEQUENCE sync_version_seq` e
    `CREATE FUNCTION set_sync_version() RETURNS trigger AS $$ BEGIN NEW.sync_version := nextval('sync_version_seq'); RETURN NEW; END $$ LANGUAGE plpgsql`;
  - `down`: remove os dois.
  - A função usa `SECURITY INVOKER`; `app_runtime` recebe `USAGE` na sequência pelos default privileges da
    Task 1, então esta migration roda depois da `AppRuntimeRole`. Se não, faça um `GRANT` explícito.
- [ ] **Step 5: Teste e2e** (`sync-version.e2e-spec.ts`): como dono, cria `sync_probe(id uuid primary key, v text)` e
  roda `addSyncVersionTrigger`.
  - `it('assigns sync_version on insert and bumps it on every update, including soft delete')`: insere e
    lê `v1`; atualiza e lê `v2 > v1`; faz o `UPDATE deleted_at` e lê `v3 > v2`;
  - `it('uses one global sequence across tables')`: com duas tabelas probe, os valores intercalados são
    estritamente crescentes.
  - Remove as tabelas no `afterAll`.
- [ ] **Step 6: Rodar** unitários e o e2e → PASS.
- [ ] **Step 7: Commit e push** — `feat(shared): domain base, uuid v7 ids, cursor pagination and sync_version infrastructure`

### Task 3: Row-Level Security por organização

**Files:**
- Modify: `src/shared/infra/db/migration-helpers.ts`
- Create: `src/shared/infra/db/organization-scope.ts`, `test/shared/rls.e2e-spec.ts`

**Interfaces:**
- Produces:
  - `enableOrganizationRls(qr: QueryRunner, table: string): Promise<void>`: roda
    `ENABLE` + `FORCE ROW LEVEL SECURITY` e cria a policy
    `org_isolation USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (mesma expressão)`;
    `disableOrganizationRls(...)` desfaz;
  - `runInOrganizationScope<T>(dataSource: DataSource, organizationId: string, work: (manager: EntityManager) => Promise<T>): Promise<T>`:
    abre uma transação, roda `SELECT set_config('app.organization_id', $1, true)` e executa `work`;
  - `abstract class OrganizationScopedRepository<TEntity extends { organizationId: string }>`, com
    `protected constructor(dataSource: DataSource, target: EntityTarget<TEntity>)` e o helper protegido
    `scoped<T>(organizationId: string, work: (repo: Repository<TEntity>) => Promise<T>): Promise<T>`, que roda
    em `runInOrganizationScope`. Todo método público das subclasses recebe `organizationId` como **primeiro**
    parâmetro. Ele também filtra `where: { organizationId }` (primeira trava); o RLS é a segunda.

- [ ] **Step 1: Teste e2e** (`rls.e2e-spec.ts`): como dono, cria `rls_probe(id uuid pk, organization_id uuid not null, v text)`,
  roda `enableOrganizationRls` e insere linhas das organizações A e B (o dono passa com `SET LOCAL` do
  contexto). Pela app (`vaulter_app`):
  - `it('returns only rows of the scoped organization')`: dentro de `runInOrganizationScope(A)`, o `SELECT`
    só traz linhas de A;
  - `it('returns nothing without an organization scope')`: um `SELECT` direto devolve 0 linhas;
  - `it('rejects writing a row for another organization')`: inserir `organization_id = B` no escopo A falha
    com `42501`;
  - `it('does not leak scope to the next transaction on the same connection')`: logo depois do escopo A, um
    `SELECT` fora de escopo devolve 0 linhas, sem erro de cast.
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit e push** — `feat(shared): organization row-level security helpers and scoped repository base`

### Task 4: Erros de domínio, filtro `problem+json` e `ValidationPipe` global

**Files:**
- Uses: `src/shared/domain/errors.ts` (criado na Task 2)
- Create: `src/shared/infra/http/{problem-details.filter,request-validation.error,configure-app}.ts`,
  `src/shared/infra/http/problem-details.filter.spec.ts`, `test/shared/problem-details.e2e-spec.ts`
- Modify: `src/main.ts`, `test/setup/test-app.ts` (usa `configureApp`)

**Interfaces:**
- Produces:
  - `abstract class DomainError extends Error { constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) }`;
    as subclasses `DomainValidationError`, `NotFoundError`, `PermissionDeniedError`, `ConflictError`,
    `HubOfflineError` e `UnauthenticatedError`;
  - `class RequestValidationError extends Error { constructor(readonly fields: { field: string; messages: string[] }[]) }`
    (com `field` no caminho em ponto, por exemplo `device.name`);
  - `configureApp(app: INestApplication): void` (pipe, filtro, logger e swagger, este na Task 6);
  - a resposta do filtro:
    `{ type: `${PROBLEM_TYPE_BASE_URL}/${code}`, title, status, detail, requestId, errors? }`, com
    `Content-Type: application/problem+json`.
- Mapeamento: `DomainValidationError` e `RequestValidationError` → 422 (o código do segundo é
  `validation-failed`); `NotFoundError` → 404; `PermissionDeniedError` → 403; `ConflictError` e
  `QueryFailedError` com `driverError.code === '23505'` → 409 (código `conflict`); `UnauthenticatedError` → 401;
  `HubOfflineError` → 503; `HttpException` do Nest → o mesmo status, com código por status (`not-found`,
  `payload-too-large`...); qualquer outro → 500 `internal-error`, com `detail` genérico, log de erro com a
  stack e `Sentry.captureException`.
- `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, exceptionFactory })`, com o
  `exceptionFactory` achatando os `ValidationError` aninhados em `RequestValidationError`.

- [ ] **Step 1: Testes unitários do filtro**, com um `ArgumentsHost` falso e `req.id = 'req-1'`:
  - `it('maps DomainValidationError to 422 problem+json with stable type')`: `status` 422,
    `body.type === 'https://errors.example.invalid/kdf-params-out-of-range'` e `body.requestId === 'req-1'`;
  - um `it` para cada linha do mapeamento acima;
  - `it('never exposes driver message or stack on 500')`: um `Error('SELECT secret FROM x')` gera um corpo
    sem `SELECT` e sem `stack`;
  - `it('maps unique violation 23505 to 409')`;
  - `it('lists invalid fields for RequestValidationError')`: `body.errors` é igual a
    `[{ field: 'device.name', messages: [...] }]`.
- [ ] **Step 2: Rodar e ver falhar.** **Step 3: Implementar.** **Step 4: Rodar** → PASS.
- [ ] **Step 5: e2e** (`problem-details.e2e-spec.ts`): `GET /does-not-exist` → 404 com `content-type` contendo
  `application/problem+json`, `type` terminando em `/not-found` e `requestId` não vazio.
- [ ] **Step 6: Commit e push** — `feat(shared): domain errors, RFC 9457 exception filter and global validation pipe`

### Task 5: Logs `nestjs-pino`, `requestId` e Sentry com limpeza

**Files:**
- Create: `src/shared/infra/observability/{sensitive-fields,logger.config,sentry.config}.ts` + specs, `src/instrument.ts`,
  `test/shared/request-id.e2e-spec.ts`
- Modify: `src/app.module.ts` (`LoggerModule.forRootAsync`, `SentryModule.forRoot()`), `src/main.ts`
  (`import './instrument.js'` na primeira linha; `bufferLogs: true`; `app.useLogger(app.get(Logger))`)

**Interfaces:**
- Produces:
  - `SENSITIVE_KEYS: readonly string[]` (as chaves das Global Constraints, nas grafias camelCase e
    snake_case, mais `authorization`, `cookie` e `password`);
  - `scrubSensitive<T>(value: T): T`: cópia profunda que troca o valor de chave sensível por `'[REDACTED]'`,
    sem diferenciar maiúsculas;
  - `pinoHttpOptions(config: ConfigService): Options`:
    - `genReqId`: usa o `X-Request-Id` recebido se casar com `/^[A-Za-z0-9-]{1,64}$/`, senão `newId()`, e
      grava o mesmo valor no cabeçalho de resposta `X-Request-Id`;
    - `redact`: `req.headers.authorization`, `req.headers.cookie`, `res.headers["set-cookie"]` e
      `*.<chave>` para cada chave sensível;
    - sem serializar o corpo; com `pino-pretty` quando `LOG_PRETTY=true`;
  - `sentryOptions(env: NodeJS.ProcessEnv): NodeOptions`: `enabled: Boolean(SENTRY_DSN)`,
    `sendDefaultPii: false`, `beforeSend` e `beforeSendTransaction`, que apagam `event.request.data`, limpam
    `request.headers`, `extra`, `contexts` e `breadcrumbs[].data` com `scrubSensitive`, e
    `tracesSampleRate` vindo do env.

- [ ] **Step 1: Testes unitários**
  - `sensitive-fields.spec.ts`: um objeto aninhado com `authProof`, `encrypted_private_key` e `Authorization`
    sai com os três `'[REDACTED]'`, os demais campos intactos e o original sem mutação;
  - `sentry.config.spec.ts`: sem DSN, `enabled === false`; o `beforeSend` de um evento com
    `request.data = {authProof:'x'}` e `headers.authorization` sai sem `data` e com o cabeçalho
    `'[REDACTED]'`;
  - `logger.config.spec.ts`: um logger pino com essas opções de `redact` escrevendo num stream de memória
    não contém o valor de `Authorization: Bearer abc`; o `genReqId` reaproveita um id válido e gera um v7 para
    `'bad id!'`.
- [ ] **Step 2: Rodar e ver falhar.** **Step 3: Implementar.** **Step 4: Rodar** → PASS.
- [ ] **Step 5: e2e** (`request-id.e2e-spec.ts`): `GET /does-not-exist` com `X-Request-Id: abc-123` devolve o
  cabeçalho `X-Request-Id: abc-123` e `body.requestId === 'abc-123'`.
- [ ] **Step 6: Commit e push** — `feat(shared): structured logging with request id and privacy-scrubbed Sentry`

### Task 6: Swagger com documentos interno e público

**Files:**
- Create: `src/shared/infra/http/swagger.ts` + spec, `test/shared/swagger.e2e-spec.ts`
- Modify: `nest-cli.json` (plugin `@nestjs/swagger` com `classValidatorShim: true` e `introspectComments: true`),
  `src/shared/infra/http/configure-app.ts`

**Interfaces:**
- Produces:
  - `PUBLIC_API_TAG = 'public'`;
  - `filterPublicDocument(doc: OpenAPIObject): OpenAPIObject`: mantém só as operações cujas `tags` incluem
    `public`, descarta paths vazios e poda `components.schemas` para os alcançáveis por `$ref` (busca
    transitiva);
  - `setupSwagger(app, config)`: o público sempre em `/docs/public` (+ `/docs/public/json`); o interno em
    `/docs` (+ `/docs/json`) só quando `API_DOCS_INTERNAL_ENABLED`; título vindo de `API_DOCS_TITLE`;
    `addBearerAuth()` no interno.

- [ ] **Step 1: Teste unitário** (`swagger.spec.ts`), com um documento de duas operações, uma `public`
  referenciando `PublicDto` e uma interna referenciando `SecretDto`:
  - o resultado tem só o path público;
  - `components.schemas` tem só `PublicDto` e os schemas que ele referencia;
  - `it('keeps nothing when no operation is public')`: `paths` sai `{}`.
- [ ] **Step 2: Rodar e ver falhar.** **Step 3: Implementar.** **Step 4: Rodar** → PASS.
- [ ] **Step 5: e2e** (`swagger.e2e-spec.ts`), com `API_DOCS_INTERNAL_ENABLED=true` no teste:
  - `/docs/json` → 200;
  - `/docs/public/json` → 200, sem nenhum path que comece com `/auth`, `/sessions` ou `/me` (assertiva
    revisitada na Task 16).
- [ ] **Step 6: Commit e push** — `feat(shared): internal and public Swagger documents`

---

## Fase 1: módulo `identity`

### Task 7: DER, tabela `user_sessions` (`.sql` e `.mwb`)

**Files:**
- Modify: `docs/der_model.sql`, `docs/der_model.mwb`

- [ ] **Step 1: Acrescentar ao `.sql`**, logo depois de `users`:

```sql
-- Sessão por aparelho (app, Hub). Não sincronizável: fica só no backend. Revogar = revoked_at; nada é apagado.
CREATE TABLE user_sessions (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  user_id CHAR(36) NOT NULL,
  device_name VARCHAR(100) NOT NULL,
  device_platform ENUM('android', 'ios', 'hub', 'web', 'other') NOT NULL DEFAULT 'other',
  refresh_token_hash VARCHAR(128) NOT NULL COMMENT 'hash do refresh atual; refresh rotativo, reuso revoga a sessão',
  refresh_expires_at DATETIME NOT NULL COMMENT '30 dias de inatividade, renovado a cada refresh',
  last_used_at DATETIME NOT NULL,
  last_ip VARCHAR(45) NULL,
  user_agent VARCHAR(500) NULL,
  revoked_at DATETIME NULL,
  revoked_reason ENUM('logout', 'revoked', 'refresh_reuse', 'password_change') NULL,
  PRIMARY KEY (id),
  INDEX ix_user_sessions_user (user_id, revoked_at),
  CONSTRAINT fk_user_sessions_users FOREIGN KEY (user_id) REFERENCES users (id)
);
```
- [ ] **Step 2: Atualizar o `.mwb`**: descompactar numa pasta do scratchpad e, em `document.mwb.xml`,
  replicar a estrutura de uma tabela existente (colunas, índices, FK e figura no diagrama, perto de `users`)
  com ids novos. Depois recompactar com a mesma ordem e o mesmo método (`lock`, `document.mwb.xml`,
  `@db/data.db`, `store` para o `lock`). Validar abrindo no `mysql-workbench-community` (sem erro de parse),
  ou pelo menos com `xmllint --noout`. A alternativa é um script Python GRT no Workbench
  (`--run-python`). Usar o que funcionar e conferir o resultado.
- [ ] **Step 3: Commit e push** — `docs: add user_sessions to data model`

### Task 8: Lado do cliente simulado (libsodium) e protocolo documentado

**Files:**
- Create: `src/shared/infra/crypto/sodium.ts`, `test/support/client-crypto.ts`, `test/support/client-crypto.spec.ts`,
  `docs/crypto/user-keys.md`

**Interfaces:**
- Produces:
  - `getSodium(): Promise<typeof sodium>` (aguarda `ready` uma vez);
  - em `test/support/client-crypto.ts`:
    - `TEST_KDF_PARAMS = { algorithm: 'argon2id13', opsLimit: 2, memLimitBytes: 67108864 }` (o mínimo
      aceito, para os testes rodarem rápido);
    - `createClientAccount(password: string, kdfParams = TEST_KDF_PARAMS): Promise<ClientAccount>`, com
      `ClientAccount = { kdfSalt, kdfParams, authProof, publicKey, encryptedPrivateKey, privateKey: Uint8Array }`,
      strings em base64url;
    - `deriveAuthProof(password, kdfSalt, kdfParams): Promise<string>`;
    - `openPrivateKey(password, kdfSalt, kdfParams, encryptedPrivateKey): Promise<Uint8Array>` (lança erro
      com senha errada);
    - `rewrapPrivateKey(privateKey: Uint8Array, newPassword: string): Promise<{ kdfSalt, kdfParams, authProof, encryptedPrivateKey }>`.
  - Segue exatamente o formato v1 das "Decisões técnicas", item 2.

- [ ] **Step 1: Testes** (`client-crypto.spec.ts`):
  - `it('round-trips the private key with the right password')`;
  - `it('fails to open with a wrong password')`;
  - `it('produces the v1 sizes')`: `publicKey` decodificada tem 32 bytes, `encryptedPrivateKey` 73 com
    `[0] === 1`, `authProof` 32 e `kdfSalt` 16;
  - `it('authProof is deterministic for same password and salt and differs from the encryption key')`;
  - `it('rewrap keeps the same private key under the new password')`.
- [ ] **Step 2: Rodar e ver falhar.** **Step 3: Implementar.** **Step 4: Rodar** → PASS.
- [ ] **Step 5: Escrever `docs/crypto/user-keys.md`**: formato v1, faixa de `kdfParams`, contexto
  `acctkeys`, como o login offline do Hub usa o mesmo material (§5.0), recuperação devolve o login e não os
  dados, refresh serializado no cliente.
- [ ] **Step 6: Commit e push** — `test(identity): client-side key derivation helper and v1 key format doc`

### Task 9: Domínio do `identity`

**Files:**
- Create: `src/identity/domain/{email,kdf-params,crypto-material,user,user.repository,session,session.repository}.ts` + specs

**Interfaces:**
- Produces:
  - `normalizeEmail(raw: string): string` (`trim` + caixa baixa);
  - `KdfParams`: `type KdfParams = { algorithm: 'argon2id13'; opsLimit: number; memLimitBytes: number }`,
    `parseKdfParams(raw: unknown): KdfParams` (lança `DomainValidationError('kdf-params-invalid')` para chave
    extra ou faltando, e `'kdf-params-out-of-range'` para valor fora da faixa) e
    `DEFAULT_KDF_PARAMS`;
  - em `crypto-material.ts`, cada função devolve a string se for válida e senão lança
    `DomainValidationError` com o código indicado:
    - `assertKdfSalt(s)`: 16 bytes, código `kdf-salt-invalid`;
    - `assertPublicKey(s)`: 32 bytes, código `public-key-invalid`;
    - `assertEncryptedPrivateKey(s)`: 73 bytes com `[0] === 0x01`, código `encrypted-private-key-invalid`;
    - `assertAuthProof(s)`: 32 bytes, código `auth-proof-invalid`;
    - todas rejeitam o que não for base64url sem padding (`/^[A-Za-z0-9_-]+$/`) e conferem que decodificar e
      recodificar devolve a mesma string;
  - `class User extends Entity<UserProps>`:
    - `UserProps = { name, email, authHash, kdfSalt, kdfParams: KdfParams, publicKey, encryptedPrivateKey, createdAt?, updatedAt? }`;
    - `static register(input: { name; email; authHash; kdfSalt; kdfParams: unknown; publicKey; encryptedPrivateKey }): User`
      (normaliza, valida tudo e faz `trim` do nome, que precisa ter de 1 a 255 caracteres, senão
      `user-name-invalid`);
    - `static restore(props: UserProps, id: string): User`;
    - `changePassword(input: { authHash; kdfSalt; kdfParams: unknown; encryptedPrivateKey }): void`;
    - getters para todas as props;
  - `abstract class UserRepository`: `findById(id): Promise<User | null>`,
    `findByEmail(normalizedEmail): Promise<User | null>`, `create(user): Promise<void>` (e-mail duplicado
    lança `ConflictError('email-already-registered')`), `save(user): Promise<void>`;
  - `type DevicePlatform = 'android' | 'ios' | 'hub' | 'web' | 'other'`;
    `type SessionRevokedReason = 'logout' | 'revoked' | 'refresh_reuse' | 'password_change'`;
  - `class Session extends Entity<SessionProps>`:
    - `SessionProps = { userId, deviceName, devicePlatform, refreshTokenHash, refreshExpiresAt: Date, lastUsedAt: Date, lastIp: string | null, userAgent: string | null, revokedAt: Date | null, revokedReason: SessionRevokedReason | null, createdAt? }`;
    - `static start(input: { id?: string; userId; deviceName; devicePlatform; refreshTokenHash; idleDays: number; now: Date; ip; userAgent }): Session`;
    - `isActive(now: Date): boolean` (sem revogação e com `refreshExpiresAt > now`);
    - `rotate(newHash, idleDays, now, ip, userAgent): void`;
    - `revoke(reason, now): void` (idempotente: a primeira revogação manda);
  - `abstract class SessionRepository`:
    - `create(session): Promise<void>`;
    - `findById(id): Promise<Session | null>`;
    - `listActiveByUser(userId, now: Date, page: CursorPageRequest): Promise<CursorPage<Session>>`, em ordem
      de `id` decrescente;
    - `rotateRefreshToken(session: Session, expectedHash: string): Promise<boolean>`, um `UPDATE`
      condicional que devolve `false` se o hash não bater;
    - `save(session): Promise<void>`;
    - `revokeAllForUser(userId, reason, now, exceptSessionId?: string): Promise<void>`.

- [ ] **Step 1: Testes unitários**:
  - `email.spec.ts`: `' Ana@X.COM '` vira `'ana@x.com'`;
  - `kdf-params.spec.ts`: aceita o padrão; rejeita `opsLimit: 1`, `memLimitBytes: 1024`, `{...,extra:1}`,
    `algorithm: 'argon2i13'`, `opsLimit: 2.5` e `null`, cada um com o código esperado;
  - `crypto-material.spec.ts`: para cada asserção, aceita o tamanho certo; rejeita tamanho errado, string
    com padding `=`, `+`/`/` e string vazia; `assertEncryptedPrivateKey` rejeita versão `0x02`;
  - `user.spec.ts`: `register` normaliza o e-mail e gera um id v7; nome só de espaços dá
    `user-name-invalid`; `changePassword` troca os 4 campos e não mexe em `publicKey`;
  - `session.spec.ts`:
    - `start` dá `refreshExpiresAt = now + 30d` e `isActive(now)`;
    - `isActive` é `false` depois da expiração e depois de `revoke`;
    - `rotate` renova o prazo a partir do novo `now`;
    - `revoke` duas vezes mantém o primeiro motivo e a primeira data.
- [ ] **Step 2: Rodar e ver falhar.** **Step 3: Implementar.** **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit e push** — `feat(identity): user and session domain`

### Task 10: Persistência: migration, entidades TypeORM, mappers e repositórios

**Files:**
- Create: `src/identity/infra/db/{user.entity,user.mapper,user.typeorm-repository,user-session.entity,user-session.mapper,user-session.typeorm-repository}.ts`,
  `src/database/migrations/<ts>-CreateUsersAndSessions.ts`, `src/identity/identity.module.ts` (só
  `TypeOrmModule.forFeature` e os repositórios por enquanto), `test/identity/repositories.e2e-spec.ts`
- Modify: `src/app.module.ts` (importa `IdentityModule`)

**Interfaces:**
- Consumes: `SyncableTypeormEntity` e `BaseTypeormEntity` (Task 2), `addSyncVersionTrigger` (Task 2), contratos da Task 9.
- Produces:
  - `UserTypeormEntity` (`@Entity('users')`, estende `SyncableTypeormEntity`, `kdfParams` em `jsonb`);
  - `UserSessionTypeormEntity` (`@Entity('user_sessions')`, estende `BaseTypeormEntity`, timestamps em
    `timestamptz`);
  - `UserTypeormRepository extends UserRepository` e `UserSessionTypeormRepository extends SessionRepository`,
    ligados no módulo com `{ provide: X, useClass: Y }`.

- [ ] **Step 1: Gerar a migration** — dentro do container, `npm run migration:generate -- CreateUsersAndSessions`.
  Revisar e completar à mão:
  - `email` com índice único **parcial** `uq_users_email ... WHERE deleted_at IS NULL` (no lugar do índice
    único gerado);
  - `id uuid DEFAULT uuidv7()` nas duas tabelas;
  - `CHECK` em `device_platform` e `revoked_reason`;
  - `addSyncVersionTrigger(queryRunner, 'users')`;
  - índice `ix_user_sessions_user (user_id, revoked_at)`;
  - `down` completo.
  - Rodar `npm run migration:run` e depois `migration:revert` + `run`, para provar o `down`.
- [ ] **Step 2: Testes de integração** (`repositories.e2e-spec.ts`, banco de teste, `resetDatabase` no
  `beforeEach`; os repositórios saem de `createTestApp().get(UserRepository)`):
  - `it('persists and reloads a user with identical fields')`: `kdfParams` volta como objeto;
  - `it('assigns sync_version on insert and bumps it on update')`: lê `sync_version` direto por SQL;
  - `it('rejects a second active user with the same email with ConflictError')`;
  - `it('allows reusing the email of a soft-deleted user')`;
  - `it('lists only active sessions of the user, newest first, with cursor')`: cria 3 ativas, 1 revogada,
    1 expirada e 1 de outro usuário. Com `limit 2` vêm 2 itens e `nextCursor`; a segunda página traz 1 item
    e `nextCursor` `null`;
  - `it('rotateRefreshToken succeeds once and fails for a stale hash')`;
  - `it('concurrent rotations with the same expected hash: exactly one wins')`: `Promise.all` de duas
    rotações dá `[true,false]` em qualquer ordem;
  - `it('revokeAllForUser keeps the excepted session active')`.
- [ ] **Step 3: Rodar e ver falhar.** **Step 4: Implementar** entidades, mappers e repositórios. O
  `create` traduz `23505` em `ConflictError('email-already-registered')`. **Step 5: Rodar** → PASS.
- [ ] **Step 6: Commit e push** — `feat(identity): users and user_sessions persistence`

### Task 11: Adaptadores de cripto e tokens

**Files:**
- Create: `src/identity/application/ports/{auth-proof-hasher,access-token-service,refresh-token-codec,decoy-salt-factory}.ts`,
  `src/identity/infra/crypto/{sodium-auth-proof-hasher,jose-access-token-service,sodium-refresh-token-codec,sodium-decoy-salt-factory}.ts` + specs

**Interfaces:**
- Produces (classes abstratas em `ports/`, implementações em `infra/crypto/`):
  - `AuthProofHasher`: `hash(authProof: string): Promise<string>`,
    `verify(authHash: string, authProof: string): Promise<boolean>`,
    `verifyAgainstDummy(authProof: string): Promise<false>`;
  - `AccessTokenService`: `issue(claims: { userId; sessionId }, now: Date): Promise<{ token: string; expiresAt: Date }>`,
    `verify(token: string, now: Date): Promise<{ userId; sessionId }>` (qualquer falha lança
    `UnauthenticatedError('invalid-access-token')`). A implementação: `jose` `SignJWT`, com
    `alg: 'EdDSA'`, `kid` de `AUTH_JWT_KEY_ID`, `iss` de `AUTH_JWT_ISSUER`, `sub` e `sid`. A chave vem de um
    JWK OKP montado a partir do seed (`d` = seed, `x` = a pública de `crypto_sign_seed_keypair`). O
    `jwtVerify` usa `algorithms: ['EdDSA']`, `issuer` e `currentDate: now`;
  - `RefreshTokenCodec`: `generate(sessionId: string): Promise<{ token: string; hash: string }>`,
    `parse(token: string): { sessionId: string; hash: string } | null` (`null` se o formato for inválido ou o
    id não for UUID). `hash` é o hex de `crypto_generichash(32, segredo)`;
  - `DecoySaltFactory`: `saltFor(normalizedEmail: string): Promise<string>`.

- [ ] **Step 1: Testes unitários**:
  - hasher: `verify(hash(p), p)` é `true`; prova errada dá `false`; o hash começa com `$argon2id$` e tem no
    máximo 255 caracteres; `verifyAgainstDummy` dá `false`;
  - token: `verify(issue(...))` devolve os claims; com `now + 901s` lança `invalid-access-token`; token
    assinado com outro seed lança; token `alg: none` montado à mão lança; payload adulterado lança; o
    cabeçalho tem `kid`;
  - codec: `parse(generate(id).token)` devolve `{ sessionId: id, hash }` com o mesmo `hash`; `parse('x')`,
    `parse('notuuid.abc')` e `parse(id + '.')` devolvem `null`; dois `generate` dão tokens diferentes;
  - decoy: mesmo e-mail dá o mesmo salt (16 bytes, aceito por `assertKdfSalt`); outro e-mail dá outro salt;
    outra chave dá outro salt.
- [ ] **Step 2: Rodar e ver falhar.** **Step 3: Implementar.** **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit e push** — `feat(identity): auth proof hashing, EdDSA access tokens and refresh token codec`

### Task 12: Casos de uso de pré-login, cadastro e login

**Files:**
- Create: `src/identity/application/{session-issuer,pre-login.use-case,register-user.use-case,login.use-case}.ts`,
  `src/identity/application/dto/{login-result,session-tokens,user-view}.ts` + specs

**Interfaces:**
- Consumes: os ports da Task 11, os repositórios e o domínio da Task 9; `ConfigService` (só no `SessionIssuer`,
  para `AUTH_REFRESH_TOKEN_IDLE_DAYS`).
- Produces:
  - `type DeviceInput = { name: string; platform: DevicePlatform }`;
    `type ClientInfo = { ip: string | null; userAgent: string | null }`;
  - `type SessionTokens = { sessionId; accessToken; accessTokenExpiresAt: Date; refreshToken; refreshTokenExpiresAt: Date }`;
  - `type UserView = { id; name; email; createdAt: Date }`;
  - `type LoginResult = { user: UserView; keys: { publicKey; encryptedPrivateKey; kdfSalt; kdfParams: KdfParams }; session: SessionTokens }`;
  - `SessionIssuer.start(user: User, device: DeviceInput, client: ClientInfo, now: Date): Promise<SessionTokens>`,
    que gera `newId()` para a sessão, monta o refresh com o codec, cria a sessão e emite o token de acesso;
  - `PreLoginUseCase.execute({ email }): Promise<{ kdfSalt; kdfParams: KdfParams }>`;
  - `RegisterUserUseCase.execute({ name; email; authProof; kdfSalt; kdfParams: unknown; publicKey; encryptedPrivateKey; device; client }): Promise<LoginResult>`;
  - `LoginUseCase.execute({ email; authProof; device; client }): Promise<LoginResult>` (falha com
    `UnauthenticatedError('invalid-credentials')`);
  - `toLoginResult(user, tokens)` e `toUserView(user)` ficam em `dto/`.

- [ ] **Step 1: Testes unitários** (repositórios e ports via `vi.fn()`; o hasher fake pode ser o real, por
  ser rápido o bastante, ou um mock):
  - pré-login, `it('returns the stored salt and params for an existing email, normalizing case')`;
  - pré-login, `it('returns the decoy salt and DEFAULT_KDF_PARAMS for unknown email')`;
  - cadastro, `it('hashes the auth proof, never storing it raw, and starts a session')`: o `authHash` do
    `create` é diferente de `authProof`, e o resultado tem `keys` iguais ao enviado;
  - cadastro, `it('rejects a malformed encryptedPrivateKey before touching the repository')`;
  - cadastro, `it('propagates ConflictError for duplicate email')`;
  - login, `it('returns user, keys and session for the right proof')`;
  - login, `it('throws invalid-credentials for wrong proof')`;
  - login, `it('throws the same invalid-credentials for unknown email and still runs verifyAgainstDummy')`;
  - login, `it('rejects a malformed authProof with invalid-credentials, not 422')` (sem dar pista do
    formato esperado da prova; decisão: 422 só no cadastro).
- [ ] **Step 2: Rodar e ver falhar.** **Step 3: Implementar.** **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit e push** — `feat(identity): pre-login, register and login use cases`

### Task 13: Casos de uso de sessão

**Files:**
- Create: `src/identity/application/{authenticate-access-token,refresh-session,logout,list-sessions,revoke-session}.use-case.ts`,
  `src/identity/application/dto/session-view.ts` + specs

**Interfaces:**
- Consumes: Tasks 9, 11 e 12 (`SessionTokens`).
- Produces:
  - `type Actor = { userId: string; sessionId: string }` em `src/identity/application/dto/actor.ts`. É o
    que os casos de uso recebem como `auth`. O `AuthContext` HTTP da Task 15 tem a mesma forma e é passado
    direto;
  - `AuthenticateAccessTokenUseCase.execute(token: string, now: Date): Promise<{ userId; sessionId }>`:
    verifica o JWT e carrega a sessão; se ela não existir, estiver inativa ou tiver `userId ≠ sub`, lança
    `UnauthenticatedError('invalid-access-token')`;
  - `RefreshSessionUseCase.execute({ refreshToken; client }): Promise<SessionTokens>`:
    - `parse` nulo ou sessão inexistente dão `UnauthenticatedError('invalid-refresh-token')`;
    - sessão inativa dá o mesmo erro;
    - hash diferente do atual: revoga com `refresh_reuse`, salva e lança `invalid-refresh-token`;
    - `rotateRefreshToken` devolvendo `false` (corrida) recebe o mesmo tratamento de reuso;
    - no sucesso, um novo token de acesso;
  - `LogoutUseCase.execute(auth): Promise<void>`: revoga com `logout`;
  - `ListSessionsUseCase.execute(auth, page: CursorPageRequest): Promise<CursorPage<SessionView>>`, com
    `SessionView = { id; deviceName; devicePlatform; createdAt; lastUsedAt; lastIp; current: boolean }`;
  - `RevokeSessionUseCase.execute(auth, sessionId): Promise<void>`: sessão de outro usuário ou inexistente
    dá `NotFoundError('session-not-found')`; já revogada é no-op; revoga com `revoked`.

- [ ] **Step 1: Testes unitários**, um para cada ramo acima:
  - refresh, `it('revokes the session with refresh_reuse when an old refresh token is presented')`;
  - refresh, `it('treats a lost rotation race as reuse')`;
  - refresh, `it('rejects an expired session without writing a revocation')`;
  - authenticate, `it('rejects a token whose session was revoked')`;
  - authenticate, `it('rejects a token whose sid belongs to another user')`;
  - list, `it('marks the current session')`;
  - revoke, `it('hides sessions of other users as not found')`.
- [ ] **Step 2: Rodar e ver falhar.** **Step 3: Implementar.** **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit e push** — `feat(identity): session authentication, rotation with reuse detection, listing and revocation`

### Task 14: Casos de uso `/me` e troca de senha

**Files:**
- Create: `src/identity/application/{get-me,change-password}.use-case.ts` + specs

**Interfaces:**
- Produces:
  - `GetMeUseCase.execute(auth): Promise<UserView>` (usuário inexistente dá
    `UnauthenticatedError('invalid-access-token')`);
  - `ChangePasswordUseCase.execute(auth, { currentAuthProof; newAuthProof; newKdfSalt; newKdfParams: unknown; newEncryptedPrivateKey }): Promise<void>`:
    - prova atual errada dá `DomainValidationError('current-auth-proof-invalid')`;
    - no sucesso, `user.changePassword` com `hash(newAuthProof)`, `save` e
      `revokeAllForUser(userId, 'password_change', now, auth.sessionId)`.

- [ ] **Step 1: Testes unitários**:
  - `it('rejects a wrong current proof and changes nothing')`: `save` e `revokeAllForUser` não são chamados;
  - `it('stores the new hash and material and revokes the other sessions only')`;
  - `it('validates the new material format')`: `newKdfParams` fora da faixa dá `kdf-params-out-of-range`;
  - get-me, `it('returns the user view without key material')`.
- [ ] **Step 2: Rodar e ver falhar.** **Step 3: Implementar.** **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit e push** — `feat(identity): me and change password use cases`

### Task 15: HTTP de autenticação: guard global, decorators, DTOs e `/auth/*`

**Files:**
- Create: `src/shared/infra/http/auth.decorators.ts`, `src/identity/infra/http/{access-token.guard,auth.controller}.ts`,
  `src/identity/infra/http/dto/{pre-login,register,login,refresh,device,login-response,session-tokens-response}.dto.ts`,
  `test/identity/auth.e2e-spec.ts`
- Modify: `src/identity/identity.module.ts` (os providers de todos os casos de uso e ports, mais
  `{ provide: APP_GUARD, useClass: AccessTokenGuard }`), `src/app.controller.ts` (`@Public()`)

**Interfaces:**
- Produces:
  - `Public(): MethodDecorator & ClassDecorator` (metadata `isPublic`);
  - `CurrentAuth()`, um param decorator que devolve `AuthContext`;
  - `AuthContext = { userId: string; sessionId: string }`;
  - `AccessTokenGuard`: pula as rotas `@Public`; lê `Authorization: Bearer <token>`, cuja ausência ou mau
    formato dá `UnauthenticatedError('invalid-access-token')`; chama
    `AuthenticateAccessTokenUseCase` e grava `request.auth`.
- Endpoints (todos `@ApiTags('auth')`, sem `public`):

  | Método | Rota | Corpo | Resposta |
  |---|---|---|---|
  | POST | `/auth/prelogin` `@Public` | `{ email }` | 200 `{ kdfSalt, kdfParams }` |
  | POST | `/auth/register` `@Public` | `{ name, email, authProof, kdfSalt, kdfParams, publicKey, encryptedPrivateKey, device: { name, platform } }` | 201 `LoginResponse` |
  | POST | `/auth/login` `@Public` | `{ email, authProof, device }` | 200 `LoginResponse` |
  | POST | `/auth/refresh` `@Public` | `{ refreshToken }` | 200 `SessionTokensResponse` |
  | POST | `/auth/logout` | — | 204 |

  - `LoginResponse = { user: { id, name, email, createdAt }, keys: { publicKey, encryptedPrivateKey, kdfSalt, kdfParams }, session: SessionTokensResponse }`;
  - `SessionTokensResponse = { sessionId, accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt }`, com as datas em ISO;
  - DTOs (formato): `email` com `@IsEmail()` e `@MaxLength(255)`; `name` de 1 a 255; blobs com `@IsString()`,
    `@Matches(/^[A-Za-z0-9_-]+$/)` e `@MaxLength(256)`; `kdfParams` com `@IsObject()` (a faixa é regra do
    domínio); `device` com `@ValidateNested()` + `@Type`, `name` de 1 a 100 e `platform` com
    `@IsIn([...])`; `refreshToken` com `@MaxLength(200)`;
  - `client.ip` vem de `req.ip` e `userAgent` do cabeçalho, truncado em 500.

- [ ] **Step 1: Testes e2e** (`auth.e2e-spec.ts`, usando `createClientAccount`):
  - `it('register → prelogin → login with the derived proof opens the private key on the client')`:
    deriva a prova a partir do salt e dos params devolvidos pelo pré-login; `openPrivateKey` com as `keys`
    do login devolve a mesma `privateKey`;
  - `it('treats email case and surrounding spaces as the same account')` (Review Focus 2);
  - `it('prelogin for unknown email is deterministic and indistinguishable in shape')` (Review Focus 5);
  - `it('login with unknown email and with wrong proof return the same 401 type')` (Review Focus 5);
  - `it('rejects malformed key material with 422 and the invalid fields, never 500')`: tabela de casos
    `encryptedPrivateKey` com padding, versão 0x02, `kdfParams.extra`, `publicKey` de 31 bytes e `name`
    de 1 MB (este dá 413 ou 422, nunca 500) (Review Focus 3);
  - `it('rejects unknown body fields with 422')`;
  - `it('refresh rotates; reusing the old refresh token revokes the session')`: depois do reuso, o novo
    refresh **também** falha e o token de acesso atual dá 401 em `/auth/logout` (Review Focus 1);
  - `it('two concurrent refreshes with the same token leave no usable session')` (Review Focus 1);
  - `it('protected route without, with malformed, with alg none or expired token returns 401 problem+json')`
    (Review Focus 4; o expirado usa `vi.setSystemTime` ou emite com `now` no passado pelo
    `AccessTokenService` obtido da app);
  - `it('logout revokes the session immediately')`: o mesmo token de acesso dá 401 logo em seguida.
- [ ] **Step 2: Rodar e ver falhar.** **Step 3: Implementar.** **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit e push** — `feat(identity): auth endpoints with global access token guard`

### Task 16: HTTP de sessões e `/me`, e documentação pública conferida

**Files:**
- Create: `src/identity/infra/http/{sessions.controller,me.controller}.ts`, `src/shared/infra/http/cursor-pagination.query.ts`,
  `src/identity/infra/http/dto/{session-view-response,change-password,me-response}.dto.ts`,
  `test/identity/sessions.e2e-spec.ts`, `test/identity/me.e2e-spec.ts`
- Modify: `test/shared/swagger.e2e-spec.ts`

**Interfaces:**
- `CursorPaginationQuery { cursor?: string (MaxLength 200); limit: number = 20 (Int, 1..100) }`.
- Endpoints (`@ApiBearerAuth()`):

  | Método | Rota | Resposta |
  |---|---|---|
  | GET | `/sessions?cursor&limit` | 200 `{ items: SessionViewResponse[], nextCursor }` |
  | DELETE | `/sessions/:id` (`ParseUUIDPipe`) | 204 |
  | GET | `/me` | 200 `{ id, name, email, createdAt }` |
  | PUT | `/me/password` | 204; corpo `{ currentAuthProof, newAuthProof, newKdfSalt, newKdfParams, newEncryptedPrivateKey }` |

- [ ] **Step 1: Testes e2e**:
  - `it('lists the user sessions across devices with pagination and marks the current one')`;
  - `it('revoking another device session makes its access and refresh tokens fail')`;
  - `it('cannot see or revoke sessions of another user (404)')`;
  - `it('GET /me returns the logged user without key material or authHash')`;
  - `it('change password: new password logs in and opens the same private key; old password fails; other sessions revoked; current session survives')`;
  - `it('change password with wrong current proof returns 422 current-auth-proof-invalid')`;
  - Swagger: `/docs/json` contém `/auth/login`, `/sessions` e `/me`; `/docs/public/json` não contém nenhum
    deles.
- [ ] **Step 2: Rodar e ver falhar.** **Step 3: Implementar.** **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit e push** — `feat(identity): sessions management and me endpoints`

### Task 17: Documentação de referência e verificação final

**Files:**
- Modify: `CLAUDE.md`, `CLAUDE.local.md`, `CLAUDE.local-example.md` (se surgir um tipo novo de referência
  local; por exemplo, o comando único para criar o login de runtime no banco existente), `README.md`, se
  citar os comandos
- Delete: nada; `app.controller`/`app.service` ficam, como rota pública de exemplo.

- [ ] **Step 1: Atualizar o `CLAUDE.md`**:
  - a seção "Módulo de referência: `identity`", com mapa de arquivos e o "como criar um módulo novo" em
    poucos passos (contratos abstratos, `forFeature`, mappers, testes unitários e e2e, `@Public`/`@CurrentAuth`);
  - "Banco de dados": papel de runtime × dono, `app_runtime` sem `DELETE`, `addSyncVersionTrigger`,
    `enableOrganizationRls`, `OrganizationScopedRepository` e banco de teste;
  - a linha `UnauthenticatedError` → 401 na tabela de erros;
  - "Sessão de usuário": detalhe final (EdDSA, 15 min / 30 dias de inatividade, reuso revoga, troca de
    senha revoga as outras);
  - as variáveis novas do `.env`;
  - os comandos e2e dentro do container;
  - um link para `docs/crypto/user-keys.md`.
- [ ] **Step 2: Verificação completa**: `npm run build && npm test && npm run lint` no host e
  `docker exec vaulter-back-app npm run test:e2e`, tudo PASS, com a saída registrada.
- [ ] **Step 3: Commit e push** — `docs: document identity reference module and shared foundation`
- [ ] **Step 4: CI**: `gh run watch` na execução do push. Precisa ficar verde. Se quebrar, usar
  `superpowers:systematic-debugging` e consertar antes de declarar pronto.
