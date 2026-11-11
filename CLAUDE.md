# CLAUDE.md — Vaulter Back

Orientações para o Claude Code neste repositório. Vale para todo o time: só entra aqui o que é verdade para
qualquer dev. Referências da sua máquina (caminhos, portas, credenciais, repos irmãos) vão no
`CLAUDE.local.md` — veja a seção [Arquivos de contexto](#arquivos-de-contexto).

## Idioma
Responda sempre em português (pt-BR). Código, nomes de variáveis, logs e mensagens de commit seguem em inglês.

## O que é
API backend do Vaulter, em **NestJS 12** + **TypeScript 6** (modo `strict`), rodando em **Node >= 20** para a API compilada; os **testes exigem Node 24** (o worker do Argon2 roda como `.ts` com remoção de tipos nativa, Node >= 22.6/23.6)
(o time usa Node 24). Repositório: `cheerokee/vaulter_back`.

## Comandos
```bash
npm install          # dependências
npm run start:dev    # API em modo watch — rodar DENTRO do container (veja Docker)
npm run build        # compila para dist/
npm test             # testes unitários (Vitest)
npm run test:e2e     # testes e2e (Vitest + supertest) — sobem o AppModule, precisam do banco; rodar DENTRO do
                     # container: docker exec vaulter-back-app npm run test:e2e
npm run migration:show                 # status das migrations (veja Banco de dados)
npm run schema:check                   # drift: falha se as entidades divergirem do banco migrado
npm run lint         # oxlint com checagem de tipos
npm run typecheck    # tsc --noEmit no projeto todo (src e test); roda no CI
npm run format       # Prettier em src/ e test/
npm run storage:reconcile [-- <min>]   # reparo do backup (índice × bucket); depois do build, no container
npm run conversations:retention        # retenção dos assuntos (30 dias); depois do build, no container, login dono
```
Antes de dizer que algo está pronto: `npm run build && npm test && npm run lint && npm run typecheck` precisam passar
(e `docker exec vaulter-back-app npm run test:e2e`, dentro do container, quando mexer em módulos/banco).

## Docker
O ambiente de desenvolvimento roda com **Docker Engine + Compose** (`docker-compose.yaml`), no mesmo modelo
do `salte/back`: o container fica **sempre de pé, ocioso**, e a API é iniciada manualmente de dentro dele.
```bash
docker compose up -d                 # sobe o container (vaulter-back-app); ele não inicia a API
docker exec -it vaulter-back-app bash
npm run start:dev                    # dentro do container: API em live reload
```
- **Primeira subida:** `.docker/start.sh` cria o `.env` a partir do `.env.example` (se não existir), roda
  `npm install` e deixa o container ocioso (`tail -f /dev/null`). Se a porta 3000 do host estiver ocupada,
  ajuste `API_PORT` no `.env` e rode `docker compose up -d` de novo.
- **A pasta inteira é montada** em `/home/node/app`, inclusive `node_modules`: `npm install` pode ser rodado
  no host ou no container, e os dois enxergam o mesmo resultado. Por isso a imagem é `node:24-slim` (glibc,
  igual ao host) — não trocar por alpine, senão os binários nativos (oxlint, vite) quebram de um lado.
- O usuário do container é `node` (uid 1000) e tem `sudo` sem senha. Histórico do bash fica em
  `.docker/bash/` (fora do git).
- `API_PORT` define só a porta no **host**; dentro do container a API sempre escuta na 3000.
- O compose tem `name: vaulter-back` fixo — não remover: sem ele o projeto se chamaria `back` (nome da pasta)
  e colidiria com outros projetos compose de mesmo nome na máquina.
- **Serviços do compose:**
  | Serviço | Container | Do app (dentro do Docker) | Do host |
  |---|---|---|---|
  | `app` | `vaulter-back-app` | — | `localhost:${API_PORT}` |
  | `db` (PostgreSQL 18 + pgvector) | `vaulter-back-db` | `db:5432` | `localhost:${DB_EXTERNAL_PORT}` |
  | `pgadmin` | `vaulter-back-pgadmin` | — | `localhost:${PGADMIN_PORT}` |
  | `aws` (LocalStack, S3 e KMS) | `vaulter-back-aws` | `http://aws:4566` | `localhost:${AWS_EXTERNAL_PORT}` |
  | `embeddings` (Ollama, nomic-embed-text) | `vaulter-back-embeddings` | `http://embeddings:11434` | `localhost:${EMBEDDINGS_EXTERNAL_PORT}` |
- **Banco único:** o Postgres guarda tanto os dados relacionais quanto os embeddings de RAG (extensão
  **pgvector**, já habilitada na criação do banco por `.docker/postgres/init/01-extensions.sql`). Não criar
  outro banco para vetores sem uma razão forte.
- Credenciais e portas vêm do `.env` (`DB_*`, `PGADMIN_PORT`); os valores padrão estão no `.env.example`.
- O pgAdmin roda em modo desktop (sem login) e já abre com o servidor `vaulter-back` cadastrado
  (`.docker/pgadmin/servers.json`); só pede a senha do banco (`DB_PASSWORD`) na primeira conexão.
- **Papel de runtime:** a API conecta como `DB_APP_USERNAME` (padrão `vaulter_app`; `NOSUPERUSER NOBYPASSRLS`,
  membro de `app_runtime`, com `SELECT/INSERT/UPDATE` e **sem `DELETE`**, exceto em `rate_limit_hits`, contador técnico — veja Rate limit), para o RLS valer de verdade. Migrations,
  CLI, testes e pgAdmin usam `DB_USERNAME` (o dono). O login é criado por `.docker/postgres/init/02-app-role.sh`
  (idempotente) na criação do banco; num banco já existente, rode uma vez:
  `docker exec vaulter-back-db sh /docker-entrypoint-initdb.d/02-app-role.sh`. As permissões ficam nas migrations.
- **Testes e2e** rodam no banco `DB_TEST_DATABASE` (padrão `${DB_DATABASE}_test`), criado e migrado pelo
  `globalSetup`; o banco de desenvolvimento nunca é truncado.
- Os dados do Postgres ficam em `.docker/pgdata/` (fora do git e do contexto de build). Para zerar o banco
  (e rodar de novo os scripts de init): `docker compose down && sudo rm -rf .docker/pgdata && docker compose up -d`.
- **S3 local:** LocalStack fixado na `4.14.0`, a última versão que roda sem `LOCALSTACK_AUTH_TOKEN` — não
  subir a versão sem decidir sobre o token. A versão gratuita **não persiste dados**: a cada subida o
  `.docker/localstack/init/ready.d/01-buckets.sh` recria o bucket `vaulter-hub-brain` (versionado), vazio.
  Novos buckets entram nesse script. Clientes S3 apontando para `aws:4566` precisam de path-style
  (`S3_FORCE_PATH_STYLE=true`). Layout do bucket: `orgs/<orgId>/spaces/<spaceId>/...`. O script também grava as
  **regras de ciclo de vida** (versões antigas e *delete markers* sozinhos em `orgs/` saem em 30 dias; o provisório de
  envio sai em 1 dia pela **tag `stage=upload`**, porque filtro de ciclo de vida só casa prefixo do começo da chave e
  `uploads/` fica no meio; o LocalStack guarda as regras mas não as executa) e o CI roda o mesmo script no serviço
  LocalStack. `S3_SKIP_SIGNATURE_VALIDATION=0` (compose e CI) faz o LocalStack conferir a assinatura das URLs
  assinadas, como o S3; sem isso o tamanho e os cabeçalhos assinados do PUT não seriam exigidos.
- **KMS local** (`SERVICES: s3,kms`): `.docker/localstack/init/ready.d/02-kms.sh` recria a cada subida a chave que
  envelopa a privada do servidor (módulo `cloud`), com **id e material fixos** (tags `_custom_id_`/`_custom_key_material_`
  do LocalStack, só de desenvolvimento) e o alias `alias/cloud-server-key` (`CLOUD_KMS_KEY_ID`): a cópia cifrada fica no
  banco, que sobrevive ao reinício do LocalStack. O CI roda o mesmo script.
- Não há imagem de produção ainda — o `Dockerfile` é só para desenvolvimento.
- Novo serviço (banco, cache, fila) entra no `docker-compose.yaml`, com suas variáveis no `.env.example`.

## Stack e convenções
- **ESM puro** (`"type": "module"`, `module: nodenext`): imports relativos levam a extensão `.js`, mesmo
  apontando para arquivos `.ts` — ex.: `import { AppModule } from './app.module.js'`.
- **Testes:** Vitest, não Jest. Globais (`describe`, `it`, `expect`, `vi`) já estão disponíveis via
  `tsconfig`. Unitários ficam ao lado do código (`*.spec.ts`); e2e em `test/` (`*.e2e-spec.ts`).
- **Lint:** oxlint (não ESLint), regras em `.oxlintrc.json`. `no-floating-promises` é erro — sempre `await`
  ou trate a promise.
- **Formatação:** Prettier com aspas simples e trailing comma (`.prettierrc`).
- **Estrutura:** veja [Arquitetura](#arquitetura).

## Decisões técnicas transversais (24/10/2026)
Decididas antes do primeiro módulo porque são caras de mudar depois. Valem também para hub e app quando
couber (spec de contas, §12).
- **Nome do produto ainda não definido** ("Vaulter" está bloqueado por marca registrada). Enquanto isso:
  - `src/` usa termos do domínio (`Hub`, `Space`, `Organization`), **nunca** o nome do produto em classes,
    módulos, tabelas ou rotas;
  - tudo que leva o nome vem do `.env` (bucket, domínio, título da documentação, emissor `iss` dos tokens, base
    das URLs `type` dos erros);
  - **rótulos de contexto da criptografia nunca contêm o nome** (ficam embutidos no dado cifrado para sempre);
  - **não criar recursos de produção** (bucket, domínio, lojas de apps) antes do nome final.
- **Criptografia:** **libsodium** no backend, no app e no hub — Argon2id (derivar chave da senha),
  X25519 + XChaCha20-Poly1305 (cifrar), Ed25519 (assinar). Todo dado cifrado começa com um **byte de versão
  do formato**. O backend quase não cifra (guarda blobs), mas valida formatos e assinaturas.
- **IDs:** **UUID v7** (ordenado pelo tempo; `uuidv7()` nativo no Postgres 18). Hub e app geram v7 offline.
- **Isolamento entre organizações:** o repositório base **exige a organização** em toda consulta de dado de
  cliente; **Row-Level Security** do Postgres como segunda trava, ligado desde as primeiras migrations.
- **Convenções da API:** JSON em **`camelCase`** (banco em `snake_case`, o mapper converte); paginação por
  **cursor**; datas em **ISO 8601, UTC**; erros com `type` **estável** (código que não muda) e mensagem
  separada, para traduzir sem quebrar integrador.
- **Hub ↔ backend:** **WebSocket puro** com mensagens **JSON versionadas** (sem socket.io, que prende os dois
  lados à biblioteca).
- **Sessão de usuário:** token de acesso curto + **refresh rotativo**, sessão **por aparelho**, revogável.
  Formato final (módulo `identity`):
  - access token **JWT EdDSA (Ed25519)** com `kid` no cabeçalho e `iss` vindo do `.env`; vale **15 min**;
  - refresh **rotativo** com **30 dias de inatividade** (cada refresh renova o prazo, sem teto absoluto); os dois
    prazos são configuráveis no `.env`;
  - a sessão é conferida **no banco a cada requisição** (busca por PK), então a revogação vale na hora;
  - **reuso do refresh token** (ou corrida entre dois refreshes com o mesmo token) **revoga a sessão**; a revogação
    é atômica, vence o primeiro motivo; **trocar a senha revoga as outras sessões** do usuário;
  - o refresh token vai **no corpo**, sem cookie (não há front web na v1);
  - **token de Hub** (`HubTokenService`, exportado da `application/` do identity, implementação `JoseHubTokenService`):
    mesmas chaves/`kid`/rotação (`JwtKeyRing`, `identity/infra/crypto`), mesmo `iss`/`aud`, `sub` = id do Hub,
    `typ: 'hub+jwt'`, 15 min fixos; o verificador de usuário fixa `at+jwt` e o de Hub `hub+jwt` (um nunca passa
    no lugar do outro; falha = 401 `invalid-hub-token`);
  - trade-off conhecido: quem souber o id de uma sessão pode forçar a revogação dela apresentando um refresh
    token forjado (não ganha acesso nenhum); os clientes devem **serializar** as chamadas de refresh.
  - **sessão presa a um Hub** (`user_sessions.hub_id`, CHECK: plataforma `hub` <=> `hub_id`): só nasce pelo
    `HubSessionIssuer.loginOnHub` (exportado; a checagem de papel é um callback `isAllowed` do `hubs`, rodado na mesma
    transação da criação da sessão). `/auth/login` com `platform: 'hub'` dá o mesmo 401 `invalid-credentials` (depois da
    mesma verificação, `CredentialCheck`). Cadastro e recuperação da conta recusam `hub` com 422 `device-invalid` **antes**
    de qualquer prova (`assertDeviceWithoutHub`; depois dela seria um oráculo do código de recuperação). `HubBoundSessions` (exportado) revoga as sessões de um Hub com o motivo
    `hub_access_lost`, chamado pelo `hubs` dentro do unit of work dele.
  - Formato v1 das chaves do usuário (Argon2id, normalização NFC da senha, vetor de teste):
    [`docs/crypto/user-keys.md`](docs/crypto/user-keys.md).
  - **Recuperação da conta pelo código de recuperação** (spec `docs/superpowers/specs/2026-11-07-account-recovery-design.md`;
    formato do código e da cópia selada em `docs/crypto/user-keys.md`): o cadastro exige `recoveryProof` e
    `recoveryEncryptedPrivateKey` (a cópia da chave privada é feita no aparelho; `users.recovery_hash`, só o hash com
    chave BLAKE2b via `IDENTITY_RECOVERY_HASH_KEY`, e `users.recovery_encrypted_private_key`, ambos NOT NULL).
    `POST /auth/recovery/lookup` devolve a chave selada com o código e `POST /auth/recovery/complete` grava o material
    novo de senha, **revoga todas as sessões** (`revoked_reason = account_recovery`) e abre uma nova (resposta de login).
    Toda falha é o mesmo 401 `recovery-failed`, com verificação falsa para o tempo não vazar; o material novo é validado
    (422) antes da prova. `PUT /me/recovery-code` troca o código (reautenticação, não revoga sessões).
    Quem rouba a senha pode trocar o código: na suspeita de comprometimento o app troca a senha **e** gera código novo,
    em sequência, nunca em paralelo (`docs/crypto/user-keys.md`).
  - **Banco local com usuários:** a migration `AddUserAccountRecovery` cria colunas NOT NULL e não há preenchimento
    retroativo (a cópia nasce no aparelho); com linhas em `users` ela falha logo no início (`users has N rows`). Zere o
    banco de desenvolvimento antes de migrar (veja Docker). O `globalSetup` só **cria** o banco dos e2e se ele faltar
    (não recria): se ele já tinha usuários de antes, apague-o uma vez e deixe o próximo `test:e2e` recriá-lo:
    `docker exec vaulter-back-db dropdb -U <DB_USERNAME> <DB_TEST_DATABASE>`.
- **Tarefas em segundo plano:** **pg-boss** (fila no próprio Postgres, sem serviço novo), atrás da porta `JobQueue`
  (`src/shared/application/job-queue.ts`; implementação `PgBossJobQueue` em `src/shared/infra/jobs/`, módulo global
  `JobsModule`). Schema próprio `pgboss`, **instalado pela migration** `CreateJobQueue` (login dono, SQL do
  `getConstructionPlans` da versão do pacote); a API conecta com o **login de runtime** (`migrate: false`, GRANT de
  SELECT/INSERT/UPDATE/DELETE no schema: exceção documentada, como `rate_limit_hits`), sem DDL em execução (filas sem
  partição, `reindex` e `persistQueueStats` desligados). Atualizar o pg-boss para uma versão de schema nova = migration
  nova com `getMigrationPlans` (veja `pg-boss-schema.ts`). **Payload só com ids** (UUID ou inteiro; `send` recusa o
  resto) e falha de tarefa guardada/logada só pelo tipo do erro (nunca a mensagem). Dentro de um `uow.run`, `send` e
  `cancelQueued` entram na transação (a tarefa só existe se ela confirmar). Pelo menos uma vez: handler idempotente, que
  reconfere sob trava. `send` com `startAfterSeconds` (atraso) e `singletonKey` (uma tarefa à espera por chave; enviar
  de novo substitui a que espera); `cancelQueued(nome, { spaceId })` apaga as que ainda esperam, num DELETE só guardado
  pelo estado (nunca uma em execução). Workers (busca,
  manutenção, cron) só com `JOB_WORKERS_ENABLED` (padrão `true`); **os e2e rodam com `false`** (enfileirar funciona,
  nada roda sozinho) e o teste que precisa liga com `createTestApp({ env: { JOB_WORKERS_ENABLED: 'true' } })`;
  `resetDatabase` apaga `pgboss.job`. **Desligamento:** os workers param (e as tarefas em execução terminam, gracioso,
  20 s) **antes** de qualquer outro gancho de destruição: `JobQueueDrain`, provider do `AppModule` (módulo raiz, o
  primeiro na fase `onModuleDestroy`; módulos globais vêm por último dentro de cada fase). O que uma tarefa usa e
  precisa liberar recursos libera em `onApplicationShutdown` quando possível (chave do servidor, cliente KMS). O pool do
  pg-boss é separado do TypeORM: `send` dentro de um `uow.run` usa a conexão da transação, mas a criação da fila (uma vez
  por processo) usa o pool do pg-boss (exceção aceita à regra de segunda conexão: pools diferentes). Versão do pg-boss
  fixada exata no `package.json` (a migration gera o SQL do pacote instalado). e2e em `test/shared/jobs.e2e-spec.ts`.
- **AWS:** região **`us-east-1` (Virgínia)** — o backend fica perto dos serviços externos (Anthropic, OpenRouter,
  Sentry), então só a ida app → backend cruza o continente; mais barata e com todos os serviços. LGPD permite
  transferência internacional com salvaguardas (o backup é cifrado e ilegível para nós). Região é
  configuração: se um cliente exigir dados no Brasil, a organização dele pode ir para um bucket em `sa-east-1`.
- **CI:** GitHub Actions (`.github/workflows/ci.yml`) em todo push na `develop`/`main` e em PR: `build`, `lint`,
  `test`, `migration:run` + `schema:check` (drift entidades × migrations) e `test:e2e` (com PostgreSQL 18 + pgvector
  como serviço). Manter verde; se quebrar, consertar antes de seguir.

## Arquitetura
Monólito modular: **uma aplicação Nest só**, um módulo por contexto (`identity`, `organizations`, `spaces`,
`hubs`, `storage`...), e **dentro de cada módulo** as camadas `domain`, `application` e `infra`. Inspirado no
`salte/back`, **sem** a separação em pacote `@core` + `nestjs` (build duplo, aliases e barrels gerados,
`providers.ts` com `useFactory`) — não reintroduzir.
```
src/
  shared/                          # base comum: Entity, erros de domínio, paginação
  spaces/
    domain/                        # puro: sem @nestjs/*, sem typeorm, sem nada de infra/
      space.ts                     #   entidade/agregado com as regras
      space.repository.ts          #   contrato: classe abstrata (serve de token de DI)
    application/
      add-member.use-case.ts       # uma classe por caso de uso, @Injectable()
      dto/
    infra/
      db/space.entity.ts           # entidade TypeORM (sufixo .entity.ts: o CLI acha por esse glob)
      db/space.mapper.ts           # domínio <-> TypeORM
      db/space.typeorm-repository.ts
      http/spaces.controller.ts
    spaces.module.ts
```
- **Domínio é puro.** `domain/` não importa `@nestjs/*`, `typeorm` nem `infra/`. Entidade de domínio e entidade
  TypeORM são classes diferentes, ligadas por um mapper.
- **Aplicação pode usar `@Injectable()`.** Casos de uso dependem do contrato do repositório (classe abstrata),
  e o módulo liga a implementação: `{ provide: SpaceRepository, useClass: SpaceTypeormRepository }`.
  Sem tokens em string e sem `useFactory` para casos de uso.
- **Fronteira entre módulos:** um módulo nunca importa a `infra/` de outro nem acessa o repositório dele; usa
  o que o outro exporta da `application/`.
- **Imports relativos** com `.js` (ESM), sem aliases nem barrels gerados.
- **Testes:** unitários no domínio e nos casos de uso (`*.spec.ts`, com o contrato do repositório simulado
  pelo `vi`); integração contra o Postgres do compose. Não criar repositório em memória para cada entidade.
- **Sem cerimônia onde não há regra:** módulos de cadastro simples mantêm a mesma estrutura, com domínio fino.
- **Validação de entrada (class-validator + class-transformer)** só nos DTOs da borda (`application/dto/` ou
  `infra/http/`), nunca no domínio. `ValidationPipe` global com `whitelist: true`, `forbidNonWhitelisted: true`
  e `transform: true`. Os decorators também alimentam o Swagger (plugin do `@nestjs/swagger`). O class-validator
  checa **formato** (obrigatório, UUID, tamanho); **regras de negócio** ficam no domínio, que lança os próprios
  erros.
- **Erros:** o domínio lança erros próprios (base em `shared/domain`), sem saber de HTTP. Um **Exception Filter
  global** em `shared/infra/http` é o único lugar que traduz para HTTP:

  | Erro | HTTP |
  |---|---|
  | `DomainValidationError` e erros do `ValidationPipe` | 422 |
  | `NotFoundError` | 404 |
  | `PermissionDeniedError` | 403 |
  | `UnauthenticatedError` (credencial ou token inválido/expirado) | 401 |
  | `ConflictError` e violação de unicidade do Postgres (`23505`) | 409 |
  | `HubOfflineError` | 503 |
  | qualquer outro | 500 genérico |

  Resposta sempre em **RFC 9457 (`application/problem+json`)**: `type`, `title`, `status`, `detail`,
  `requestId` (e, em validação, a lista de campos inválidos). Um erro de domínio 4xx com `details` leva esses campos
  como **membros de extensão** do RFC 9457 (nunca sobrepõem os padrão), ex.: `key-rotation-mismatch` com
  `expectedHubIds`/`missingHubIds`/`unexpectedHubIds`/`duplicatedHubIds` (e o mesmo para `...UserIds`) ou
  `expectedVersion`, e `organization-under-protection` (422) com `protectedUntil`. Só ids que quem chamou já pode ver. Erros 4xx do body-parser (413 corpo grande,
  400 JSON malformado) também saem como problem+json. Stack trace, SQL e mensagem crua do banco vão só
  para o log, nunca para a resposta.
- O modelo de dados e as regras de negócio vêm da spec
  `valter-valt-ai/docs/superpowers/specs/2026-10-24-organizacoes-espacos-e-nuvem-design.md`, do DER em
  `docs/der_model.sql` e, para organizações, de `docs/superpowers/specs/2026-10-25-organizations-design.md`.

## Módulo de referência: `identity`
`src/identity/` é o modelo a copiar; `src/shared/` é a base comum (Entity/UUID v7, erros, paginação, filtro
`problem+json`, config/validação do `.env`, naming strategy, entidades base, helpers de migration/RLS, logs e Sentry).
```
src/identity/
  domain/            email, kdf-params, crypto-material (value objects); user, session (+ *.repository.ts abstratos)
  application/       um use-case por arquivo (+ *.spec.ts ao lado); ports/ (contratos de cripto/token);
                     session-issuer.ts; dto/
  infra/
    db/              *.entity.ts, *.mapper.ts, *.typeorm-repository.ts
    crypto/          implementações das ports (libsodium, jose)
    http/            controllers, access-token.guard.ts, dto/ (class-validator + Swagger)
  identity.module.ts
test/identity/       e2e do módulo;  test/setup/ (globalSetup, test-app);  test/shared/ (e2e da base)
test/support/        helpers e fixtures de teste compartilhados (cliente de cripto, identity-client, sessões)
```
**Como criar um módulo novo:**
1. `domain/`: entidade/value objects com as regras (lançam erros de `shared/domain`) e o contrato do repositório
   como **classe abstrata** (serve de token de DI).
2. `application/`: um caso de uso `@Injectable()` por arquivo, dependendo só dos contratos; DTOs de saída.
3. `infra/db/`: entidade TypeORM (`*.entity.ts`, estendendo as bases de `shared/infra/db`, com **todas** as
   constraints nos metadados), mapper domínio ↔ entidade e repositório que implementa o contrato. O repositório
   injeta o `DataSource` (não `@InjectRepository`) e resolve o `Repository` **a cada operação** com
   `currentManager(this.dataSource).getRepository(Entidade)` (ex.: um getter `private get repo()`), para entrar na
   transação do `UnitOfWork` quando houver uma — veja "Unit of work" em Banco de dados.
4. Migration em `src/database/migrations/` (`addSyncVersionTrigger` / `enableOrganizationRls` quando couber;
   dado de cliente tem `organization_id` e RLS); `migration:generate` depois dela deve sair vazio.
5. `infra/http/`: controllers e DTOs de borda. Rotas exigem token por padrão (guard global); abra uma rota com
   `@Public()` e leia o chamador com `@CurrentAuth()` (ambos em `src/shared/infra/http/auth.decorators.ts`).
6. `<modulo>.module.ts`: `TypeOrmModule.forFeature([...])` e `{ provide: Contrato, useClass: Implementacao }`.
7. Testes: unitários com contratos simulados via `vi`, ao lado do código; e2e em `test/<modulo>/`, reaproveitando
   `test/support/`.

## Módulo `organizations`
`src/organizations/` (organizações, membros, papéis/RBAC, convites, chave de recuperação, auditoria, assentos).
Spec: `docs/superpowers/specs/2026-10-25-organizations-design.md` (§6 = catálogo RBAC, §7 = rotas).
```
src/organizations/
  domain/        organization, membership (MembershipRules), invitation, recovery-key, email, seat-policy,
                 rbac-catalog (fonte da verdade em código); *.repository.ts abstratos
  application/   um use-case por arquivo; organization-access.ts (padrão para os outros módulos);
                 membership-guard.ts (lock + contexto de membro); audit-log.ts; invitation-errors.ts;
                 personal-organization.registration-hook.ts; ports/ (gerador/hash do token de convite)
  infra/         db/ (entidades, mappers, repositórios), crypto/, http/ (3 controllers, dto/)
```
- **Dependência em uma direção só: `organizations` -> `identity`**, e apenas por contratos exportados da
  `application/` do identity: `UserDirectory` (nome/e-mail/chave pública de usuários) e
  `CurrentAuthProofVerifier` (reautenticação). O `identity` nunca importa `organizations`.
- **Ganchos de cadastro** (`RegistrationHooks`, `src/shared/application/registration-hooks.ts`): é como um módulo
  reage ao cadastro sem o `identity` conhecê-lo. O módulo assina em `onModuleInit` (`register({ name, onRegistered })`,
  `unregister` no destroy); os ganchos rodam em sequência **dentro da transação do cadastro** (erro desfaz tudo) e
  os resultados são mesclados (dois ganchos devolvendo o mesmo campo = erro de programação). Hoje:
  `organizations.personal` cria a organização pessoal (dono = admin) e, com `inviteToken`, tenta aceitar o convite
  (`invitation.accepted` na resposta do cadastro; convite inválido não derruba o cadastro, só erro de domínio em
  savepoint).
- **Ganchos de saída e de convite** (`MemberRemovedHooks`, `InvitationHooks`, em `src/shared/application/`, globais
  como o de cadastro; mesma regra de assinatura): o `spaces` reage sem o `organizations` importá-lo.
  `MemberRemovedHooks.run({ organizationId, userId, actorId, reason: 'removed' | 'left', now })` roda no unit of
  work de `RemoveMemberUseCase`/`LeaveOrganizationUseCase`, depois da lápide do vínculo; erro desfaz a saída.
  `InvitationHooks.validateAndRecord({ organizationId, invitationId, actorId, spaces })` roda na criação do convite
  (só com `spaces` preenchido; sem nenhum inscrito -> 422 `spaces-not-supported`, a intenção nunca some) e
  `onAccepted({ organizationId, invitationId, userId, now })` no aceite, depois do vínculo (também quando a pessoa
  já era membro e o convite só foi consumido; vale para a rota logada e para o gancho de cadastro). O DTO aceita
  `spaces` (até 20, sem `spaceId` repetido -> 422 `duplicate-space`).
- **`OrganizationDirectory`** (exportado, junto com `OrganizationAccess` e `AuditLog`): `isActiveMember(orgId, userId)`,
  `recoveryPublicKey(orgId)` (`null` se não houver), `organizationIdsOf(userId)` (organizações ativas da pessoa),
  `personalOrganizationIdOf(userId)` (a organização pessoal, ou `null`), `hubLinkPolicy(orgId)` (`null` se desconhecida) e `allowRoomSpaces(orgId)` (`false` se desconhecida), sem lançar
  para org/usuário inexistente. Não é checagem de autorização. `allowRoomSpaces` (padrão `true`, no `PATCH`) bloqueia
  só **novas** liberações na Sala dos Hubs. **Franquia de nuvem:** `storageQuota(orgId)` (leitura) e
  `lockStorageQuota(orgId)` (trava a linha da organização `FOR NO KEY UPDATE`, **folha**: depois de Hubs e espaço) devolvem
  `{ quotaBytes, reservedBytes }`; a regra é `assertOrganizationStorageFits` (`application/organization-storage.ts`,
  422 `organization-storage-quota-exceeded` com `availableBytes`). O reservado (`OrganizationRepository.reservedStorageBytes`)
  é soma de `spaces.storage_quota_bytes` em SQL: **exceção documentada** à fronteira (como a sincronização do Hub).
  `organizations.storage_quota_bytes` padrão 50 GiB; `GET /organizations/:id` traz `storage: { quotaBytes, reservedBytes }`.
- **`OrganizationAccess` é o padrão para os próximos módulos (spaces, hubs):** `requireMember(orgId, userId)` ->
  **404** para não membro (não revela que a organização existe); `requirePermission(orgId, userId, permissao)` ->
  **403** para membro sem a permissão. Todo caso de uso que toca dado de organização chama um dos dois primeiro;
  ids malformados viram 404/422 antes de chegar ao banco. Operações que mudam admins/membros usam
  `lockMembershipContext` (trava `org_admin` com `FOR UPDATE`, reconfere o acesso sob o lock): remover, rebaixar ou
  sair concorrentes se serializam e a organização nunca fica sem admin (`last-admin`, 422). Dono da organização
  pessoal: `personal-owner-protected` / `cannot-leave-personal`.
- **RBAC:** catálogo (permissões, dependências, papéis de fábrica e suas permissões) é semeado por **migration
  imutável** (`CreateRbacCatalog`; mudar o catálogo = nova migration) e o e2e confere banco == `rbac-catalog.ts`.
  `permissions`, `permission_dependency` e `role_permission` são só leitura para o runtime **por GRANT** (só
  `SELECT`); em `roles`, os papéis de fábrica (`organization_id IS NULL`) são protegidos pelo **RLS**, e o runtime
  pode gravar papéis da própria organização (base dos papéis próprios futuros). Papéis de fábrica: `org_admin` (`org.members.manage`, `org.spaces.create`,
  `org.hubs.approve`, `org.billing`), `org_member` (nenhuma), `space_reader/editor/manager`, `hub_owner/operator/...`
  (detalhe na spec §6). Atribuição em `role_assignments` (escopo organização/espaço/hub); a API de membros só mexe em
  `org_admin`/`org_member`.
- **RLS das tabelas da organização:** policies só com `current_setting` (`app.organization_id`, `app.user_id`,
  `app.invitation_token_hash`); **sem `SECURITY DEFINER`** — funciona com dono não superusuário (Postgres gerenciado).
  `app.invitation_token_hash` deixa a prévia/aceite ler **só** o convite do token antes de haver organização no
  contexto. Em código, `runInOrganizationScope`/`uow.withContext` (escopo restaurado ao sair). **Unidades aninhadas
  dentro de um mesmo `uow.run` precisam ser sequenciais** — nunca `Promise.all` de `run`/`withContext` (a transação
  e o contexto são uma conexão só).
- **Convites:** o token do link (43 chars base64url) aparece **uma única vez**, na resposta da criação; no banco só o
  hash. O token **sempre vai no corpo** (`POST /invitations/preview`, `POST /invitations/accept`), nunca em URL (log,
  histórico, Referer). Vale 7 dias, uso único (aceite concorrente: um ganha, o outro 422). Convite com e-mail só serve
  para esse e-mail. Prévia pública devolve só nome da organização, de quem convidou e validade (sem e-mail). Qualquer
  falha (inexistente, expirado, revogado, usado, outro e-mail) é o **mesmo erro** `invitation-invalid` (422), para
  não virar oráculo. O cadastro aceita `inviteToken`. **O convite morre com a permissão de quem o criou:**
  remover, sair ou rebaixar de `org_admin` revoga os convites pendentes dessa pessoa na mesma transação
  (`revokeInvitationsOfCreator`, auditado `invitation.revoked` com `reason: creator_lost_permission`), e prévia/aceite
  reconferem o criador (`invitationCreatorCanInvite`) — admin removido não volta pelo próprio link.
- **Chave de recuperação da organização:** `PUT /organizations/:id/recovery-key` só **substitui** (nunca apaga),
  exige `org.members.manage` **e** reautenticação (`currentAuthProof`, verificada por `CurrentAuthProofVerifier`, com o
  rate limit de reautenticação compartilhado com `PUT /me/password`) e é auditada (`registered`/`replaced`, sem a
  prova nem a chave privada). Grava **quem e quando** trocou (`recovery_key_changed_by_user_id`/`_at`).
- **Proteção depois da nomeação pela plataforma** (decisão do Jonas, 09/11/2026; spec platform-roles §4.4): quando
  `OrganizationAdministration.appointAdmin` **grava** (o alvo ainda não era admin) com ator `platform`, a organização ganha
  `platform_appointed_user_id`, `platform_appointed_at` e `protected_until = now + 7 dias`
  (`PLATFORM_APPOINTMENT_PROTECTION_DAYS`, domínio; uma nomeação nova sobrescreve os três e reinicia a janela; nomear de novo
  quem já é admin não reinicia). Enquanto `now < protected_until`, **ninguém** da organização (o nomeado, quem ele
  promover, os admins antigos) registra/troca o kit (`PUT .../recovery-key`) nem remove membro (`DELETE .../members/:userId`):
  422 `organization-under-protection` com `protectedUntil` (ISO) como membro de extensão. A regra é do agregado
  (`Organization.assertNotUnderProtection`/`recordPlatformAppointment`), conferida na transação depois da reconferência
  da permissão e antes de qualquer gravação (a ordem formato -> permissão -> reautenticação -> transação continua).
  Continuam permitidos: sair, mudar papel, convites, reabrir espaço órfão com o kit **atual** e o resto. Sem
  liberação antecipada (nenhuma rota nem ação da equipe). Motivo: um admin nomeado (ou uma conta dele) trocaria o kit,
  esperaria os apps retrancarem, removeria os membros e leria as chaves pelos espaços órfãos.
  **Locks:** toda leitura-modificação-gravação da linha da organização (kit, `PATCH`, nomeação) lê com
  `OrganizationRepository.lockForUpdate` (`FOR NO KEY UPDATE`, não bloqueia inserções de filhos), porque o `save` grava
  a linha inteira; a nomeação trava `org_admin` -> organização; a remoção já serializa com ela pelo `org_admin`.
- **Visão da organização** (`toOrganizationView`, em `GET /organizations`, `GET/PATCH /organizations/:id`, e devolvida
  pelo caso de uso do kit) traz `recoveryKeyChangedAt`, `recoveryKeyChangedByUserId` e `platformAppointment:
  { appointedUserId, appointedAt, protectedUntil } | null` (mostrada até `protectedUntil` + 30 dias,
  `PLATFORM_APPOINTMENT_NOTICE_DAYS`; depois `null`), para todo membro. `recoveryKeyChangedAt`/`recoveryKeyChangedByUserId`
  **nulos com kit registrado** significam **"desconhecido"** (kit registrado antes de esse registro existir), nunca
  "nunca trocado": o app não deve tratar como kit original confiável. **Nada disso vai para a sincronização do Hub.**
  **Recomendação para o app:** avisar **todos os membros** enquanto `platformAppointment` estiver presente e, **antes de
  retrancar** um espaço para um kit novo, mostrar quem trocou o kit e quando e pedir confirmação.
- **Auditoria (`audit_logs`):** *append-only* — o papel de runtime tem só `INSERT`/`SELECT` (sem `UPDATE`/`DELETE`),
  via `AuditLog.record` dentro da mesma transação da ação. Ações: `organization.created`, `organization.updated`,
  `organization.recovery_key.registered|replaced`, `member.joined`, `member.left`, `member.removed`,
  `member.role_changed`, `invitation.created`, `invitation.revoked` e as `space.*` do módulo `spaces` (inclusive
  `space.recovery_copies_read`, quando um admin lê as cópias do kit de um espaço órfão) e `space.backup.trash_emptied`
  (do `storage`, quando o Gestor esvazia a lixeira do backup). `metadata`
  nunca leva segredo/token/cópia trancada.
- **Assentos:** assento = membro ativo (convite pendente não conta). `SeatPolicy` (hoje ilimitado) é checada ao criar
  e ao aceitar convite. TODO ao entrarem limites reais: travar a linha da organização (`FOR UPDATE`) antes de contar,
  senão requisições concorrentes estouram o limite.
- Rotas autenticadas marcam `@ApiBearerAuth()` por método (a prévia de convite é `@Public()` e não deve aparecer
  com cadeado no Swagger). Nenhuma rota daqui entra na doc pública.

## Módulo `spaces`
`src/spaces/` (espaços, membros do espaço, versões da chave e cópias trancadas, pendências de trancar).
Spec: `docs/superpowers/specs/2026-10-25-spaces-design.md`. Depende de `organizations` e `identity` (só o que eles
exportam); nenhum dos dois importa `spaces`.
- **`SpaceAccess`** (exportado, padrão para storage/hubs): `requireSpaceMember(spaceId, userId)` -> **404**
  `space-not-found` para quem não é membro do espaço (inclusive admin da organização), espaço inexistente ou de outra
  organização; `requireSpacePermission(..., permissao)` -> **403** para membro sem a permissão. A organização é
  descoberta pelas linhas de `role_assignments` da própria pessoa (`findOrganizationOfMember`, só `app.user_id`).
  Operações só de admin (promover Gestor, reabrir pelo kit) usam `requireOrgPermissionForSpace`: procura o espaço só
  nas organizações em que a pessoa tem a permissão (404 para o resto). Mutações usam `lockAsMember` /
  `lockWithOrgPermission` dentro do `uow.run`: checagem sem lock, `FOR UPDATE` no espaço, checagem de novo.
- **Kit de recuperação (`RecoveryKit`):** quem grava `recovery_wrapped_key` manda `recoveryPublicKey`; sem kit 422
  `recovery-key-required`, kit diferente 409 `recovery-key-changed`; a impressão gravada vem da chave da organização.
- **Ganchos** (contratos em `src/shared/application/`, veja "Ganchos de saída e de convite"): `spaces.member-removed`
  roda no unit of work da saída da organização e, se falhar, **desfaz a saída inteira** (trava os espaços da pessoa
  em ordem de id, lápide em cópias e papéis, marca `keyRotationRequired`, cancela pendências, audita; pode deixar
  espaço sem Gestor ou órfão, o que é permitido). `spaces.invitation` valida na criação do convite (só Gestor do
  espaço o indica; erro de validação desfaz a criação) e grava a intenção em `invitation_space_intents`
  (com `requestedByUserId`, o Gestor que indicou); no aceite vira `space_pending_grants`. Sem o módulo `spaces`
  registrado, convite com `spaces` dá 422 `spaces-not-supported`. Outros módulos que reagirem a saída/convite assinam
  do mesmo jeito, sem o `organizations` importá-los.
- **Sala dos Hubs (`SpaceRoomService`, exportado para o `hubs`):** a Sala é uma linha de `role_assignments` com
  `room_hub_id` (escopo espaço, papel `space_reader`/`space_editor`, `uq_role_assignments_space_room_hub`) mais a
  cópia de cada versão em `space_key_grants.hub_id`. O `spaces` não conhece a tabela `hubs`: `grantRoom` recebe o
  `hubId` e um `confirmHubLink(orgId)` do chamador (roda antes do lock do espaço: vínculo, depois espaço), exige
  Gestor, `allowRoomSpaces` só para liberação nova (422 `room-not-allowed`; liberar de novo ou trocar o papel de um
  Hub já na Sala continua permitido), kit atual e as cópias de **todas** as versões; o assento
  conta no `SPACE_MAX_MEMBERS` (pessoas + Hubs). `revokeRoom` (Gestor, ou `trusted` quando o chamador já autorizou),
  `revokeRoomForOrganization` e `revokeAllRoomForHub` gravam lápide no papel e nas cópias e marcam
  `keyRotationRequired`; auditoria `hub.room.granted|revoked`. A troca de chave exige `hubGrants` com exatamente os
  Hubs da Sala (409 `key-rotation-mismatch`). As consultas de membros do espaço (`SpaceRoleRepository`, `memberCount`)
  contam **só pessoas** (`user_id IS NOT NULL`).
- **`SpaceMemberLeftHooks`** (`src/shared/application/`, global como os outros ganchos): o `spaces` emite
  `{ organizationId, spaceId, userId, now }` no Remove, no Leave e, no gancho de saída da organização, uma vez por
  espaço; roda no unit of work da saída, depois das lápides, e erro desfaz a saída.
- **Tamanho do espaço** (spec storage-backup §4.4): `spaces.storage_quota_bytes` (padrão 10 GiB, 1 GiB..5 TiB, escolhido
  na criação com `storageQuotaBytes`); criar confere a franquia com `lockStorageQuota` antes do kit e do insert.
  `PUT /spaces/:id/storage-quota` (`ResizeSpaceStorageUseCase`, Gestor): diminuir nunca abaixo do uso (422
  `space-storage-quota-below-usage`); aumentar confere a franquia e os ganchos **`SpaceQuotaHooks`**
  (`src/shared/application/`, global: `lock` antes do lock do espaço, `assertIncrease` depois; o `hubs` confere a
  capacidade de cada Hub onde o espaço está, 422 `hub-storage-full` com `hubId`, e `missingBytes` só para o dono do Hub); auditado
  `space.storage_quota_changed`. O **uso** vem da porta `SpaceStorageUsage` (exportada): a **soma das fontes
  registradas** (`register(nome, fonte)` em `onModuleInit`, `unregister` no destroy; lidas uma depois da outra, na
  transação de quem chama; sem fonte, 0): `storage` (backup) e `conversations` (corpo das mensagens). `SpaceStorage.lockQuota` (exportado)
  lê o tamanho com o espaço `FOR SHARE` (instalação no Hub). `GET /spaces/:id`, a criação e o resize trazem
  `storage: { quotaBytes, usedBytes }`; o `GET` traz também `trashBytes` (a parte do uso na lixeira, da porta
  `SpaceStorageUsage.trashBytes`, opcional na fonte; sem ela, 0). Bigint do banco vira número por `byteCount` (`shared/infra/db/byte-count.ts`).
- **Fluxo de chaves** (cifra no app; o backend só guarda blobs e valida formato — libsodium, formato em
  `docs/crypto/user-keys.md`, seção da cópia trancada: `0x01 ‖ crypto_box_seal`, 81 bytes, base64url, 108 chars):
  - cada **versão** da chave do espaço é uma linha de `space_keys` (`spaces.current_key_version`); **todo membro tem
    cópia de todas as versões** (`space_key_grants`), senão perde o histórico;
  - quem **sai** (da organização ou do espaço) ou é removido deixa `keyRotationRequired = true`; um membro faz a
    **troca** (`rotate`): versão nova, uma cópia por membro ativo (até `SPACE_MAX_MEMBERS`) e a cópia do kit, o
    que limpa a flag. A versão da troca não tem teto, mas **sem a flag só o Gestor troca** (manual, ex.: suspeita
    de vazamento; os outros: 409 `key-rotation-not-required`) e a rota tem limite de 10/h por usuário
    (`RATE_LIMITS.spaceKeyRotation`) — senão um Leitor inflaria as versões além de `MAX_KEY_VERSIONS`;
  - **retrancar** (`rewrap`) regrava o kit da organização para todas as versões quando o kit muda, com a impressão
    do kit informada (`RecoveryKit`; 409 `recovery-key-changed` se divergir);
  - **antes de trocar o kit da organização**, o app confere `GET /organizations/:orgId/spaces?all=true` (itens com
    `memberCount` e `recoveryRewrapRequired`): espaço **órfão** (`memberCount = 0`) com versões no kit atual precisa
    ser **reaberto antes** (ninguém dentro dele retranca; com o kit novo, a cópia do kit antigo não abre mais), ou o
    kit antigo deve ser guardado até todo espaço ser retrancado. Depois da troca, quem ainda está no kit antigo
    aparece com `recoveryRewrapRequired`;
  - **órfão** (nenhum membro com papel): só um admin com `org.members.manage` reabre, **pelo kit**, em dois passos
    com reautenticação: `POST /spaces/:id/recover/copies` devolve as cópias do kit de todas as versões
    (`recoveryWrappedKey` + impressão; auditado `space.recovery_copies_read`, sem as cópias), o app abre com a parte
    secreta do kit e `POST /spaces/:id/recover` manda as cópias de todas as versões seladas para o admin;
    é a única forma de um admin se pôr num espaço. **Promover Gestor** também é operação de admin (404 se fora da org);
  - pôr membro novo exige as cópias de **todas** as versões no mesmo pedido; o convite aceito deixa uma **pendência
    de trancar** (`space_pending_grants`) que o Gestor resolve (põe a cópia) ou recusa **por id**.
- **HTTP** (`infra/http/`: `spaces`, `space-members` e `space-keys` controllers; rotas da spec §7, todas internas,
  tag `spaces`): ids de caminho passam pelo `uuidPipe` (`src/shared/infra/http/uuid-pipe.ts`, 422
  `validation-failed`); listas usam `pageResponse` (`cursor-pagination.query.ts`). Cópia trancada no DTO:
  `^[A-Za-z0-9_-]{108}$`; chave do kit: 43 caracteres. A recusa de pendência é por id
  (`DELETE /spaces/:id/pending-grants/:pendingGrantId`); `POST /spaces/:id/recover` e `POST /spaces/:id/recover/copies`
  usam `@ThrottleReauth()`.
- **Limites (spec §8):** `SPACE_MAX_MEMBERS = 500` (domínio; pôr o 501º -> 409 `space-member-limit`; o DTO da troca
  de chave usa a mesma constante). Pôr membro, retrancar e reabrir mandam **todas as versões num pedido só**
  (`MAX_KEY_VERSIONS = 500`, ~71 kB < 100 kB do corpo JSON); a versão da troca não tem teto. Perto do limite:
  aumentar o limite do corpo JSON nessas rotas ou aceitar versões em lotes por faixa.
- **Tabelas:** `spaces`, `space_keys`, `space_key_grants`, `space_pending_grants`, `invitation_space_intents`, além
  de `role_assignments` com `scope_type = 'space'` (papel do espaço; `space_id` só nessas linhas, por CHECK). Todas
  com RLS por organização. As FKs de filho de espaço são **compostas** `(filho_id, organization_id) ->
  (pai.id, pai.organization_id)`, com `UNIQUE (id, organization_id)` em `spaces`, `space_keys` e
  `organization_invitations`: **a checagem de FK ignora o RLS**, então sem a coluna da organização na FK um filho
  de uma organização poderia apontar para um espaço de outra.
- **Ordem de locks** (sempre nesta ordem, para não dar deadlock): linha de vínculo do alvo (`user_organization`, `FOR SHARE`)
  -> linha do espaço (`FOR UPDATE`) -> atribuições de Gestor (`lockSpaceManagers`, em ordem de id). O gancho de saída
  trava vários espaços em ordem de id. Mutações do módulo passam por `SpaceAccess.lockAsMember` /
  `lockWithOrgPermission`.
- **Pendências (não feito ainda):** nuvem ativa (`cloud_mode = active_cloud`, só o campo existe); excluir espaço; papéis próprios de
  espaço (só os de fábrica); notificações (pendência e troca de chave hoje só aparecem por consulta).
- **e2e com a cripto real do cliente:** os helpers de espaço ficam em `test/support/identity-client.ts`
  (`c.spaces`: criar com kit, pôr membro selando todas as versões, trocar a chave, retrancar, abrir as cópias) e
  as invariantes de banco em `test/support/spaces-db.ts`. Não duplicar nos specs.

## Módulo `hubs`
`src/hubs/`. Spec: `docs/superpowers/specs/2026-11-01-hubs-design.md`; formato das assinaturas do Hub em
`docs/crypto/hub-identity.md`; **ciclo de vida do Hub** (sequência do primeiro boot ao reset de fábrica, para quem
implementa o aparelho e o app) em `docs/hubs/hub-lifecycle.md` — mudou rota, corpo, erro ou limite de Hub, atualize-o
no mesmo commit. Depende de `identity` (`HubTokenService`), `organizations` (`OrganizationAccess`,
`OrganizationDirectory`, `AuditLog`) e `spaces` (`SpaceAccess`, `SpaceRoomService`), só pelo que eles exportam;
nenhum deles importa `hubs`. Única exceção: a sincronização lê tabelas dos outros módulos por um repositório de
consulta só de leitura (veja Sincronização).
- **Identidade do Hub:** o aparelho gera um par Ed25519 e assina mensagens JSON canônicas com **rótulo** de uso
  (`hub-enroll-v1`, `hub-status-v1`, `hub-auth-v1`, sem o nome do produto; formato, vetor, regras de
  canonicalização e a receita em Python (`json.dumps(..., sort_keys=True, separators=(',', ':'),
  ensure_ascii=False)`, timestamp terminando em `Z`) em `docs/crypto/hub-identity.md`, implementação única em
  `domain/hub-signed-message.ts`). **Uma apresentação pendente por chave** (índice único parcial
  `uq_hub_enrollments_pending_signing_key`): a apresentação nova expira a anterior da mesma chave na mesma transação
  (replay com nonce repetido não derruba a pendente) e, na corrida, quem perde expira a outra e tenta de novo. O código
  de reivindicação (8 dígitos) e o desafio de autenticação ficam no banco só como hash com chave
  (`HUB_CODE_HASH_KEY`, BLAKE2b, domínio próprio por uso); trocar a chave invalida o que está pendente. O token de
  Hub sai de `POST /hub-auth/token` (desafio assinado, uso único); o desafio de Hub inexistente ou desregistrado é
  um **desafio falso** igual ao verdadeiro.
- **`HubAccess`** (exportado, `application/hub-access.ts`, padrão para sincronização e controllers):
  `find(hubId, userId)` -> `{ hub, role } | null`; `requireAccess` -> **404** `hub-not-found` para quem não vê o Hub
  (desregistrado, inexistente, id malformado: o mesmo 404); `requireOwner` -> **403** para quem vê e não é dono.
  `role` = `hub_owner` | `hub_operator` | `hub_user` (explícito ou implícito para membro de organização com vínculo
  aprovado). **Autorização é sempre do caso de uso**: `HubOrganizationRepository.upsert` troca para o contexto do Hub
  por dentro, então todo caso de uso confere dono / membro (`OrganizationAccess.requireMember`) / admin
  (`org.hubs.approve`) antes de escrever.
- **Ordem de locks dos Hubs:** linha do Hub (`HubRepository.lockForShare`; `lockForUpdate` no desregistro;
  `lockForStorage` = `FOR NO KEY UPDATE` ao instalar espaço e no aumento de espaço, serializando quem mexe no que está
  instalado contra a capacidade; sempre o primeiro lock) -> linha do vínculo (`HubOrganizationRepository.lockForUpdate`; `lockForShare` na liberação da Sala
  e ao pôr espaço) -> `hub_space` -> espaço -> Gestores -> assuntos (`conversations`, sempre por último, em ordem
  (espaço, assunto); o gancho `HubExecutorLostHooks` roda depois da Sala no desregistro, no desvínculo e ao tirar espaço). Desvincular segura o vínculo `FOR UPDATE` antes de
  `revokeRoomForOrganization`. O gancho de saída do espaço (`hubs.space-member-left`) roda com o espaço já travado e
  **só lê** vínculos. O gancho de saída da organização do `hubs` tem duas fases em `MemberRemovedHooks`: `order: -10`
  só trava (Hub -> vínculos do dono com a organização -> linhas de hub_space), antes do `spaces`; `order: +10`
  desvincula. A Sala já caiu na rodada de espaços do `spaces` (só o dono que é Gestor libera, e a liberação cai quando
  ele sai do espaço), então a cascata não trava uma segunda rodada de espaços. Atribuir papel de Hub trava Hub ->
  vínculo (FOR SHARE) -> vínculo do alvo com a organização. Para quem não é dono, aprovar/recusar/desvincular dá o
  mesmo 404 `hub-link-not-found` para Hub inexistente e para Hub sem vínculo (não revela que o Hub existe).
- **Vínculos** (casos de uso em `application/`): o dono vincula (`any_member_hub` aprova na hora;
  `admin_approved` espera um admin); outro membro pede com o **código de vínculo** do Hub (8 dígitos, 10 min, uso
  único, só hash com domínio próprio; código inválido/vencido/usado/de Hub desregistrado = o mesmo 422
  `link-code-invalid`; a resposta não traz o `hubId`; trava o vínculo de quem pede com a organização,
  `lockActiveMember`, antes do Hub, como o vínculo pelo dono); aprovar/recusar/desvincular: dono ou admin. **O admin
  acha o pedido** em `GET /organizations/:orgId/hub-links` (`OrganizationHubLinksController`, no `hubs`; exige
  `org.hubs.approve`: 404 não membro, 403 sem a permissão; `?status=` opcional; cursor por id do Hub; devolve
  `hubId`, `hubName`, status, `requestedByUserId` e os dois consentimentos): é o único jeito de ele saber o `hubId` de
  um pedido pendente, porque ainda não vê o Hub pelo RLS (o nome vem de uma leitura no contexto de cada Hub,
  `HubRepository.namesOf`, depois da autorização). **Aprovar usa
  sempre a política ATUAL**, mesmo quando aquele lado já consentiu (resolve o pendente quando a organização relaxa).
  Desvincular (`HubLinkCascade`, um `uow.run`): vínculo `revoked`, espaços da organização fora do Hub, Sala e cópias
  com troca pendente, papéis de Hub de quem ficou sem organização vinculada, auditoria. A organização pessoal do
  dono é vinculada **sempre aprovada** na reivindicação (`ownerLinksAsOrgAdmin`: os dois consentimentos são dele).
- **Espaços no Hub / Sala / papéis / desregistro:** pôr = dono membro do espaço ou Gestor (422
  `organization-not-linked` sem vínculo aprovado); tirar = dono ou Gestor, e tira da Sala. Liberar na Sala = dono
  que é Gestor, espaço já no Hub (422 `space-not-on-hub`). Papéis `hub_operator`/`hub_user` só para membro de
  organização vinculada (422 `user-not-in-linked-organization`; dono 422 `hub-owner-protected`). Desregistrar (só o
  dono): Hub `FOR UPDATE` primeiro, lápide nos vínculos, nos espaços e em todos os papéis do Hub (inclusive
  `hub_owner`/`hub_room`, só o contexto do dono alcança) e a Sala cai em **toda organização a que o Hub já foi
  vinculado** (`listAllOrgIds`, com lápides e revogados). Auditoria sem organização (`hub.claimed`,
  `hub.deregistered`, `hub.role.changed`) vai para a organização pessoal do dono.
- **Capacidade do Hub** (spec storage-backup §4.5): `hubs.storage_capacity_bytes` (nula até o Hub informar), gravada
  por `PUT /hub/storage` (`@HubAuth()`, `{ capacityBytes }` 1 GiB..64 TiB, 204; só a coluna, `setStorageCapacity`;
  menor que o reservado é aceito). Instalar (`AddHubSpaceUseCase`): Hub `lockForStorage` -> vínculo (share) ->
  `hub_space` (share) -> espaço (`SpaceStorage.lockQuota`, share); com capacidade, soma dos tamanhos instalados em
  **todas** as organizações (`HubSpaceRepository.reservedBytes`, cada organização no próprio escopo; lê
  `spaces.storage_quota_bytes` em SQL, como `add` já lê `spaces`) + o novo ≤ capacidade, senão 422 `hub-storage-full`
  (`missingBytes` **só para o dono do Hub**: a soma conta as outras organizações; quem não é dono recebe o erro sem
  números, só o `hubId` no aumento); espaço já instalado não conta de novo. Aumento de espaço (`HubsSpaceQuotaHook`, em `SpaceQuotaHooks`):
  trava os Hubs do espaço antes do espaço; depois relê e trava com `NOWAIT` um Hub que apareceu no meio (409
  `hub-storage-busy`, raro). `GET /hubs/:id` traz `storage: { capacityBytes, reservedBytes }` (o dono soma tudo; os
  outros, só as organizações de que são membros ativos). e2e em `test/storage/quotas.e2e-spec.ts`.
- **`hub_space` e Sala** (a Sala em si é do `spaces`; veja `SpaceRoomService` lá): `hub_space` diz quais espaços de
  uma organização vinculada estão no Hub (FK composta para o vínculo, lápide ao tirar). Liberar na Sala exige
  espaço já no Hub, `allowRoomSpaces` só para liberação **nova** (422 `room-not-allowed`; liberar de novo ou trocar
  o papel de um Hub já na Sala segue permitido), cópias de **todas** as versões, e o Hub conta no `SPACE_MAX_MEMBERS`.
  Troca de chave sem `hubGrants` com exatamente os Hubs da Sala dá 409 `key-rotation-mismatch` (com
  `expectedHubIds`/`missingHubIds`/`unexpectedHubIds`). **Como o app descobre a Sala para trocar a chave:**
  `GET /spaces/:id` traz `roomHubs: [{ hubId, roleKey }]` para todo membro do espaço (lido pelo `spaces` em
  `role_assignments`, sem importar `hubs`), e a chave de cifra de cada Hub vem de `GET /hubs/:id`: todo membro do
  espaço é membro ativo da organização, e a Sala só existe com vínculo **aprovado** dela (desvincular e desregistrar
  derrubam a Sala), então `HubAccess` sempre deixa ele ver o Hub. Escolhido em vez de copiar a chave para o `spaces`
  (nenhuma porta nova, nenhum dado duplicado). O helper de e2e `c.spaces.rotate` descobre os Hubs assim
  (`roomHubRecipients`); `hubs` explícito só para mandar um conjunto errado de propósito.
- **Ganchos:** `SpaceMemberLeftHooks` (o `hubs` tira da Sala o que o dono, ao sair do espaço, havia liberado);
  `MemberRemovedHooks` ganhou `order` (menor roda antes): o `hubs` assina duas vezes, `-10` (só trava) e `+10`
  (cascata). Dono do Hub que sai da organização (removido ou saindo) tem seus Hubs desvinculados dela.
- **Login de pessoa pelo Hub** (`POST /hub/user-sessions`, token de Hub; `LoginPersonOnHubUseCase` +
  `HubPersonSessions`): só quem tem papel no Hub (`HubAccess.hasAccess`, num contexto limpo: só `app.user_id`), senão o
  mesmo 401 `invalid-credentials`. A sessão fica presa ao Hub e cai (`hub_access_lost`) quando a pessoa perde todo
  papel nele: `HubPersonSessions.revokeLostAccess` roda **por último** em tirar papel, desvincular e no gancho `+10`
  de saída da organização; o desregistro revoga todas as sessões do Hub. Corrida login × revogação: o login segura o
  Hub FOR SHARE e um advisory lock das sessões do Hub (`HubRepository.lockPersonSessions`) compartilhado até o COMMIT; a
  varredura pega o advisory exclusivo por último (vários Hubs em ordem de id). Fixado por
  `test/hubs/user-sessions.e2e-spec.ts`. O `AuthContext`/`Actor` traz o `hubId` da sessão (da linha da sessão, a cada
  requisição; nulo numa sessão comum): módulos que restringem o que uma sessão de Hub alcança leem dali (hoje os
  assuntos: só os executados por esse Hub).
- **RLS das tabelas de Hub:** contexto novo `app.hub_id` (token de Hub) e `app.hub_signing_public_key` (abre só o Hub
  daquela chave: a apresentação confere se a chave já está em uso); o dono lê/grava seus Hubs; o Hub lê **todos** os
  próprios vínculos (qualquer status) e só os `hub_space` de vínculo aprovado; em `role_assignments` de escopo Hub o
  contexto do Hub só pode **gravar lápide** em linha viva atribuível (nunca criar nem reativar). `hubs` usa GRANT de
  UPDATE por coluna (`name`, `last_seen_at`, `deleted_at`, `updated_at`, `storage_capacity_bytes`: chave de assinatura e
  dono imutáveis). `hub_organization.hub_owner_user_id` é cópia
  desnormalizada do dono para a policy (FK composta com `hubs`): numa transferência de Hub futura, atualizar.
- **Testes:** helpers em `test/support/hubs-kit.ts` (reivindicar com a cripto real, código de vínculo, atalhos dos
  casos de uso, estado cru de vínculos/espaços/papéis) e `test/support/hub-client.ts` (o aparelho pela HTTP: gera as
  chaves, apresenta, consulta o status assinado, autentica, pede código de vínculo, sincroniza; `onboard` faz o fluxo
  inteiro com a reivindicação do dono). e2e pela HTTP em `test/hubs/http.e2e-spec.ts` e `test/hubs/rate-limit.e2e-spec.ts`.
- **HTTP** (`infra/http/`: `hub-enrollments`, `hub-auth`, `hubs`, `hub-organizations` (+ `HubLinkCodesController`),
  `organization-hub-links`,
  `hub-spaces` e `hub-sync` controllers; rotas da spec §7, todas internas, tag `hubs`): públicas do aparelho
  (`/hub-enrollments`, `/hub-auth/*`) sem cadeado no Swagger; rotas `/hub/*` só com token de Hub; o resto só com token de
  usuário. Ids de caminho pelo `uuidPipe`, **exceto** `GET /hub-enrollments/:id/status` (id malformado, assinatura
  ausente/inválida e apresentação inexistente = o mesmo 404; só o timestamp dá 422). O status lê `X-Hub-Signature` e
  `X-Hub-Timestamp`. O token de Hub sai como `{ accessToken, expiresAt }`. O código de reivindicação só aparece na
  resposta da apresentação; a chave de assinatura do Hub não sai em nenhuma resposta. `DELETE /hubs/:id/roles/:userId`
  é 204 com ou sem papel (idempotente). Listas (`GET /hubs`, `GET /hubs/:id/organizations`, `GET /hubs/:id/spaces`)
  são por cursor (`pageResponse`; vínculos em ordem de id da organização, espaços em ordem de id do espaço, fundindo
  as organizações de quem não é dono; helper `pageFrom` em `shared/domain/pagination.ts`). Toda resposta passa por um
  mapper explícito (`dto/responses.ts`). DTOs: códigos `^[0-9]{8}$`, chaves 43 caracteres base64url, assinatura 86,
  nonce 22, desafio 43, cópia trancada 108 (formatos próprios do módulo em `dto/hub.dto.ts`).
- **Rotas de Hub:** `@HubAuth()` (`src/shared/infra/http/hub-auth.decorators.ts`, em `shared` para outros módulos, como o
  `storage`, marcarem as próprias rotas de Hub sem importar `hubs/infra`) marca a rota como `@Public()` para o
  guard de usuário e o `HubTokenGuard` (APP_GUARD do `HubsModule`, que vem **antes** do `ThrottlingModule`) exige o
  token de Hub (`typ: hub+jwt`) de um Hub existente e não desregistrado; `@CurrentHub()` lê `{ hubId }`. Token de
  usuário em rota de Hub e token de Hub em rota de usuário: 401.
- **Sem oráculo:** reivindicação com código errado, desconhecido, vencido ou já usado = o mesmo 422
  `claim-code-invalid` (o nome é conferido antes do código); consulta de status com assinatura inválida ou
  apresentação inexistente = o mesmo 404 `enrollment-not-found`; desafio de Hub inexistente ou desregistrado = um
  desafio falso igual (`hub_id` nulo, nunca valida); toda falha do token = o mesmo 401 `hub-auth-failed`.
- **Reivindicação** (`ClaimHubUseCase`, um `uow.run`): trava a apresentação (`FOR UPDATE`), cria o Hub, consome a
  apresentação, dá `hub_owner` ao dono e `hub_room` à Sala, vincula a organização pessoal (sempre aprovada) e audita
  `hub.claimed` na organização pessoal. Hub ou apresentação inexistente é verificado contra a chave falsa única
  (`HubSignatureVerifier.decoyPublicKey()`: um par Ed25519 aleatório por instância, ponto válido).
- **Sincronização** (`GET /hub/sync?since=&limit=`, `SyncHubUseCase` + `HubSyncSqlReader`; contrato completo no
  comentário do caso de uso): `{ items: [{ type, syncVersion, deleted, data }], nextSince }`, `limit` 1..500 (padrão
  500). O leitor é uma **exceção documentada** à fronteira entre módulos: projeção só de leitura, em SQL, sobre as
  tabelas de identity/organizations/spaces (mudou coluna lá, atualize as consultas). Transação `REPEATABLE READ, READ
  ONLY` (um snapshot só); organizações aprovadas lidas de `hub_organization` no contexto do Hub e cada uma lida em
  sequência com `{ organizationId, hubId }`. **O que garante o escopo:** a lista de organizações é protegida só pelo
  filtro `status = 'approved'` do leitor (o RLS deixa o Hub ler todos os próprios vínculos; fixado por
  `test/hubs/sync.e2e-spec.ts`, "an organization without an approved link never appears" e "an unlink followed by a
  new request"); `hub_space` (e, por ele, espaços, chaves e cópias) continua exigindo vínculo aprovado também no RLS. `member` é por (organização, pessoa), versão = maior `sync_version` entre
  vínculo, usuário e papéis embutidos — um mesmo valor pode estar em vários itens; a página nunca parte esse grupo.
  Lápide leva só as chaves. O Hub lê **todos** os próprios vínculos (`hub_read`, qualquer status): todo vínculo que
  não é `approved` vivo (revogado, e também pendente/recusado, porque pedir de novo reaproveita a linha revogada)
  chega como lápide. **Cascata local do Hub:** lápide de `hub_organization` ou de `hub_space` = o Hub apaga
  localmente o que dependia dele; **sincronização completa** (`since=0`) **substitui** o estado local; **entrada no
  escopo** numa passada incremental (vínculo aprovado ou `hub_space` vivo que o Hub não tinha) = o Hub faz uma
  sincronização completa (as linhas mantêm o `sync_version` antigo). Tipos de item: `hub`, `hub_organization`,
  `organization`, `member`, `role_assignment`, `space`, `space_key`, `space_key_grant`, `hub_space`; nunca `authHash`,
  cópia do kit nem cópia de outro Hub. Empate de `sync_version`: ver comentário de `mergeSyncPage` (a página só passa
  de `limit` quando um único grupo é maior que ele). **Consulta de status** (`GET /hub-enrollments/:id/status`, 120/h
  por IP, que atrás de NAT é dividido entre aparelhos): recomendar intervalo de **pelo menos 60 s** com jitter e parar
  no estado final. **Intervalo recomendado da sincronização** (`hubSync` = 120/h por Hub, e a completa e cada página
  também contam): incremental a cada **5 min** com jitter de ±20% (12/h), sempre `limit=500`, e na mesma passada
  pedir as páginas seguintes enquanto vier página cheia; isso deixa ~100 pedidos/h para páginas extras e
  sincronizações completas (~50 mil itens). Com 429, esperar o `Retry-After`; nunca repetir em laço apertado.
- **Testes (helpers):** `test/support/hub-crypto.ts` (cripto do aparelho: chaves, assinaturas), `hub-client.ts` e
  `hubs-kit.ts` (acima). Não duplicar nos specs.

## Módulo `platform`
`src/platform/` (equipe Vaulter: papéis da plataforma, pedidos de suporte, auditoria própria). Spec:
`docs/superpowers/specs/2026-11-07-platform-roles-design.md`. Quase nada do que a equipe fará existe ainda: o módulo
entrega a **estrutura** (catálogo, atribuição, trava das rotas, auditoria) e duas ações de suporte. A equipe **nunca**
ganha acesso a conteúdo (as chaves ficam com os clientes).
- **Papéis e permissões** (`domain/platform-catalog.ts`, fonte da verdade em código; semeado pela migration
  `CreatePlatformRoles`, imutável: mudar o catálogo = nova migration; o e2e confere banco == catálogo; `resetDatabase`
  dos testes restaura o catálogo como faz com o RBAC). Permissões: `platform.roles.manage`, `platform.support.request`,
  `platform.support.approve`, `platform.support.execute_alone`, `platform.audit.read`, `platform.billing.storage_quota`
  (migration `PlatformStorageQuotaPermission`). Papéis: `platform_admin` (todas), `platform_support` (`support.request`
  + `audit.read`), `platform_finance` (só `billing.storage_quota`). **Franquia de nuvem:** `PUT /platform/organizations/:orgId/storage-quota`
  `{ quotaBytes, reason, currentAuthProof }` (financeiro ou admin; `@ThrottleReauth`): `OrganizationAdministration.setStorageQuota`
  trava a organização, 422 `storage-quota-below-reserved` abaixo do reservado, audita `organization.storage_quota_changed`
  (ator `AuditActor` `platform_staff`, sem pedido de suporte, `user_id` nulo) e `platform.organization.storage_quota_changed`. Conta normal do `identity`
  com um papel por cima (`user_platform_role`); atribuição em tabelas próprias, só a equipe.
- **Fronteira:** o `platform` depende de `identity`, `organizations` e `hubs` só pelo que exportam; nenhum deles importa
  `platform`. Exporta `PlatformAccess` e `PlatformAudit`. O papel da plataforma nunca aparece em resposta de cliente nem
  na sincronização.
- **Trava das rotas** (`PlatformPermissionGuard`, lê as atribuições **no banco a cada requisição**; vale na hora):
  controller marcado com `@PlatformRoutes()` e cada rota com `@RequirePlatformPermission(p)` ou
  `@RequireAnyPlatformRole()` (rota sem requisito num controller da plataforma: 500, falha fechada). O guard é
  **global** (APP_GUARD do `PlatformModule`, que vem **antes** do `ThrottlingModule`; fora dos controllers da plataforma
  não faz nada): quem não é da equipe recebe o 404 antes do throttler, **sem** `X-RateLimit-*`, `Retry-After` nem 429,
  igual a uma rota inexistente (fixado por `test/platform/staff.e2e-spec.ts`). Sem papel ou sem a permissão: **404** igual ao do Nest
  para rota inexistente (`Cannot <METHOD> <url>`), para não revelar que `/platform/*` existe. `GET /platform/me` usa
  `@RequireAnyPlatformRole()` (o financeiro tem papel mas nenhuma permissão).
- **Rotas** (todas internas, token de usuário): `GET /platform/me`; `GET /platform/staff`,
  `PUT|DELETE /platform/staff/:userId/roles/:roleKey` (`roles.manage`, reautenticação; retirar o último admin:
  422 `last-platform-admin`); `POST|GET /platform/support-requests`, `GET .../:id`, `POST .../:id/approve|reject`
  (`GET /platform/support-requests` e `GET .../:id` exigem `platform.audit.read` e, sem `platform.support.approve`,
  mostram só os pedidos do próprio usuário: o de outra pessoa é o mesmo 404 de pedido inexistente; o vencimento de
  7 dias é gravado **na leitura** (lista e detalhe) e **na decisão**, sem tarefa agendada);
  `GET /platform/audit`; buscas para achar o alvo: `GET /platform/lookup/users` (por e-mail),
  `/platform/lookup/hubs/:hubId`, `/platform/lookup/organizations/:orgId` (só `platform.support.request`; id, nome,
  dono, status, nada cifrado). Pedir, aprovar, recusar e mexer em papéis entram no orçamento `reauth`.
- **Primeiro admin:** `npm run platform:grant-admin -- <email>` (`node scripts/platform-grant-admin.ts <email>`), com o
  login **dono** do banco (`DB_USERNAME`), dentro do container; idempotente; conta inexistente ou linha
  `platform_admin` ausente do catálogo: erro e sai com 1, sem gravar; auditado em `platform_audit_logs` com
  `user_id` nulo e via `cli`. É o único jeito de criar admin sem já ser admin.
- **Pedidos de suporte** (`SupportRequest`): tipos `hub_force_deregister` (alvo `hubId`) e `org_appoint_admin` (alvo
  `organizationId` + `userId`); motivo e prova obrigatórios (até 2000 caracteres). Estados `pending`, `executed`,
  `rejected`, `expired` (sem decisão em 7 dias), `failed` (erro de domínio na execução: o pedido guarda o `type` do
  erro e nada muda no alvo). Quem tem `platform.support.execute_alone` (admin) cria o pedido já aprovado e executado na
  mesma transação; suporte cria **pendente** e outra pessoa com `platform.support.approve` aprova (executa na hora) ou
  recusa com nota; quem pediu nunca aprova o próprio (`self-approval`, 422). **Quem pediu perde
  `platform.support.request`** (papel retirado): os pendentes dele viram `rejected` na mesma transação da retirada, sem
  decisor e com nota `requester_lost_permission` (auditado `platform.request.rejected` com `metadata.reason`, sem
  usuário); a decisão reconfere quem pediu sob o lock do pedido e, se perdeu, recusa do mesmo jeito (gravado) e responde
  409 `support-request-not-pending`. A execução (`SupportRequestExecutor`) roda
  num `uow.run` aninhado (savepoint): erro de domínio desfaz só a ação e vira `failed`; outro erro desfaz tudo.
- **Ordem de locks da plataforma** (sempre nesta ordem, sem ciclo): atribuições vivas de `platform_admin`
  (`lockAdmins` FOR UPDATE em conceder/retirar papel; `lockAdminsForShare` FOR SHARE ao criar e ao decidir pedido, antes
  de reconferir permissões e o alvo da equipe) -> linha do pedido (`lockById` FOR UPDATE; na retirada,
  `lockPendingOf` trava os pendentes da pessoa em ordem de id) -> locks da operação executada (Hub/organização). Conceder/retirar papel e decisões/criações se serializam, então a retirada vale na hora
  e um alvo não vira equipe no meio de uma nomeação. Conceder/retirar nunca travam Hub nem organização. Sem nenhum
  admin vivo (só em teste), o FOR SHARE não trava nada.
- **Regras de alvo:** organização pessoal recusada (`personal-organization-protected`, 422); **ninguém da equipe pode ser
  nomeado** admin (`staff-cannot-be-appointed`, 422), conferido na criação **e de novo na execução**. O nomeado pode ser
  membro atual ou qualquer conta cadastrada (vira membro e admin), mesmo havendo admins.
- **Operações administrativas exportadas** (recebem um `AuditActor`, `src/shared/application/audit-actor.ts`:
  `{ kind: 'user', userId }` ou `{ kind: 'platform', supportRequestId }`; `auditActorFields` dá o `userId` e a metadata
  de cada gravação): `HubAdministration.deregister(hubId, actor)` (mesmo efeito e mesma ordem de locks do
  `DeregisterHubUseCase`, sem exigir o dono) e `OrganizationAdministration.appointAdmin(orgId, userId, actor, now)`
  (replica a ordem de locks do `lockMembershipContext`, sem membro ator: `org_admin` travados antes de ler o alvo, depois
  a linha da organização). Quando grava com ator `platform`, `appointAdmin` abre a **janela de proteção de 7 dias** da organização (sem
  troca de kit nem remoção de membro para ninguém; 422 `organization-under-protection`; veja "Proteção depois da
  nomeação pela plataforma" no módulo `organizations`), e a nomeação aparece para todos os membros em
  `platformAppointment`. Cada uma tem também `summary` (consulta mínima das buscas).
- **Auditoria:** trilha própria `platform_audit_logs` (*append-only*; `platform.role.granted|revoked`,
  `platform.request.created|approved|rejected|executed|failed|expired`, `platform.lookup.user|hub|organization`), em
  `PlatformAudit.record` dentro da mesma transação. **Toda busca é auditada** (rastro LGPD de quem da equipe olhou dado
  de cliente), achando ou não: o alvo achado nas colunas `target_*` e `metadata.found`; num 404, só `found: false` (e o
  id procurado de Hub/organização em `metadata`); o e-mail procurado **nunca** é gravado. O que mexe numa organização também vai ao `audit_logs` dela, com `user_id` **nulo** e
  `metadata { actor: 'platform', supportRequestId }` (a conta da equipe não é exposta ao cliente). Existem agora **dois
  formatos de `member.joined`**: o normal (`user_id` = quem entrou) e o da plataforma (`user_id` nulo e a pessoa que
  entrou em `metadata.targetUserId`). **Nenhuma rota de cliente lê o `audit_logs` ainda** (pendente).
  `GET /platform/audit` exige `platform.audit.read` e, sem `platform.support.approve`, mostra só os pedidos do próprio
  usuário; aceita `supportRequestId` e cursor.
- **Desregistro forçado:** é a saída para um Hub preso numa conta perdida (veja `docs/hubs/hub-lifecycle.md`); o dono
  legítimo faz o reset de fábrica e reivindica de novo com a conta nova.
- **Limite residual conhecido:** um papel perdido entre o guard e a reconferência dentro da transação pode expor o
  detalhe genérico "The resource was not found.".
- **Testes:** e2e em `test/platform/` (`catalog`, `staff`, `support-requests`, `lookup`); unitários ao lado do código.

## Módulo `storage`
`src/storage/` (índice do backup, envio, apagar, listar, baixar, reparo). Backup cifrado dos espaços no S3. Spec:
`docs/superpowers/specs/2026-11-09-storage-backup-design.md`; formato do blob cifrado em `docs/crypto/space-backup.md`;
o lado do aparelho em `docs/hubs/hub-lifecycle.md` (§9, §10; mudou rota, corpo, erro ou limite do backup, atualize-o no
mesmo commit).
- **Fronteiras:** `storage` depende de `spaces` (`SpaceContentAccess`, e a porta `SpaceStorageUsage`, que ele liga), de
  `hubs` (`HubDirectory`: organizações de vínculo aprovado do Hub), de `identity` (`CurrentAuthProofVerifier`, para
  esvaziar a lixeira) e de `organizations` (`AuditLog`), só pelo que exportam; só o `conversations` importa `storage` (a
  porta `ObjectStore` e a `application/`, para os anexos).
  Leituras entre módulos, todas documentadas onde nascem: o `organizations` soma `spaces.storage_quota_bytes` em SQL
  (franquia; veja "Franquia de nuvem" em `organizations`), o `hubs` lê `spaces.storage_quota_bytes` em SQL ao instalar
  (veja "Capacidade do Hub" em `hubs`) e a sincronização do Hub já era exceção. `SpaceStorageUsage` (porta do `spaces`,
  soma das fontes registradas, sem fonte = 0) tem `register(nome, fonte)` (o `storage` registra `storage` e o
  `conversations` registra `conversations` em `onModuleInit`) e `replace(source)`, a costura de teste que troca TODAS
  as fontes por uma e devolve a função de restauração. A intenção de envio lê o uso pela porta (conta as mensagens e os anexos dos assuntos). O `storage` exporta só a porta
  `ObjectStore` (provider) e, pela `application/`, a peça compartilhada `object-uploads.ts` (o `conversations`
  reaproveita o mecanismo para os anexos); a varredura `storage:reconcile` roda também os ganchos
  `StorageReconcileHooks` (`src/shared/application/`). Tamanho do espaço e franquia: veja "Tamanho do espaço" em `spaces`.
- **Regras de tamanho** (`domain/backup-limits.ts`; mudar qualquer valor é decisão de produto): espaço 10 GiB por padrão
  (1 GiB..5 TiB), franquia da organização 50 GiB (só o financeiro da plataforma altera: `PUT /platform/organizations/:orgId/
  storage-quota`, veja `platform`), objeto até 5 GiB (422 `object-too-large`), lote de 100 itens por pedido
  (intenção, confirmação, apagar), URL assinada 15 min, reserva da intenção 24 h, lixeira 30 dias (conta no uso), página
  de listagem até 1000, 10 versões antigas por objeto (`MAX_TRASH_VERSIONS_PER_OBJECT`), esvaziar a lixeira em lotes de
  1000 versões (`MAX_PURGE_BATCH_VERSIONS`). O uso do espaço = versões `committed` + lixeira + reservas vivas (as
  `purged` não contam); não cabe: 422
  `space-storage-full` (`missingBytes`). Capacidade do Hub: instalar/aumentar além do SSD informado = 422
  `hub-storage-full`; corrida entre instalações no mesmo Hub = 409 `hub-storage-busy` (repetir).
- **Enviar, confirmar, apagar** (rotas do Hub `/hub/spaces/:spaceId/...` e da pessoa `/spaces/:spaceId/backup/...`, os
  mesmos casos de uso por `StorageAccess`; limites na tabela de rate limit): intenção `POST .../uploads` (reserva o
  tamanho, assina um PUT por objeto no prefixo provisório `uploads/<uploadId>`, tag `stage=upload`), PUT direto no S3,
  confirmação `POST .../uploads/confirm` (HEAD confere tamanho/sha256, cópia no servidor para a chave final, versão
  `committed`; idempotente) e `POST .../objects/delete` (delete marker, lápide, 30 dias de lixeira; idempotente).
  **Quem pode:** enviar e apagar = `memory.write` (Hub com o espaço na Sala como `space_editor`; pessoa
  `space_editor`/`space_manager` de qualquer sessão; apagar exige o mesmo que substituir, decisão da revisão final: senão o
  que o Hub criou e apagou voltaria numa restauração); ler = `memory.read`
  (veja Listar e baixar). Hub fora da Sala ou sem permissão e não membro: 404 `space-not-found`. Erros: 409
  `space-key-rotation-required` (envio novo recusado enquanto a troca de chave estiver pendente; **apagar continua
  valendo**), 409 `space-key-version-stale`, 409 `object-version-conflict` (`currentVersionId`), 409 `storage-busy`,
  422 `duplicate-object` (objeto repetido no pedido), 404 `upload-not-found` (inexistente, de outro espaço/remetente, vencida),
  422 `upload-mismatch` (bytes diferentes do declarado ou PUT não feito), 422 `confirm-batch-too-large` (uma confirmação
  copia no máximo 5 GiB declarados, `MAX_CONFIRM_BATCH_BYTES`). Confirmar só quem pediu a intenção (o mesmo Hub ou a
  mesma pessoa); outro: 404 `upload-not-found`.
- **O índice é a verdade; o S3 só guarda bytes.** Toda leitura, listagem e download usa o `s3VersionId` gravado no
  índice (`storage_object_versions`), **nunca** a versão "atual" do S3 (que pode estar errada por um instante depois de
  uma queda entre o S3 e o COMMIT). Vale para listar, baixar e tudo que vier.
- **Travas:** intenção de envio = espaço `FOR UPDATE` (lê o uso e reserva; duas intenções do mesmo espaço se
  serializam; sem chamada ao S3 sob a trava); confirmação e apagar = espaço `FOR SHARE` (não aumentam o uso) + linhas
  dos objetos `FOR UPDATE` em ordem de id, com as chamadas ao S3 (HEAD, cópia no servidor, delete marker) **sob** essas
  travas, para a ordem das versões no S3 ser a do índice. Trade-off aceito: enquanto um lote de confirmação roda (até
  100 cópias), redimensionar, trocar a chave, pôr/tirar membro, tirar da Sala e o gancho de saída da organização
  (todos `FOR UPDATE` no espaço) esperam o lote; confirmações e apagamentos do mesmo espaço correm juntos. Limites do
  trade-off: o lote copia no máximo 5 GiB (`confirm-batch-too-large`), e `StorageAccess.lock` põe `lock_timeout` de 10 s
  (`STORAGE_LOCK_TIMEOUT_MS`, `uow.setLockTimeout`) para o resto da transação da intenção, da confirmação e do apagar:
  esperar mais que isso pelo espaço ou por um objeto = 409 `storage-busy` (55P03, `lockTimeoutAsBusy`), em vez de o
  pedido segurar uma conexão do pool (`DB_POOL_MAX_CONNECTIONS = 10` por instância, em `typeorm.options.ts`).
  **Esvaziar a lixeira** trava o espaço FOR SHARE e até os objetos do lote (até 1000 versões) FOR UPDATE em ordem de id,
  só pelas gravações no índice (o S3 vem depois do COMMIT): enquanto isso, confirmações e apagamentos do Hub nesses
  objetos podem receber 409 `storage-busy` (repetível) e o que trava o espaço FOR UPDATE espera.
- **Diário + reparo:** a marca `s3_write_started_at` é o instante (no **relógio do banco**) em que a tentativa mais
  recente de gravar no S3 por esta linha começou, gravado **antes** de qualquer gravação dela no S3 (o S3 é tocado
  nesse instante ou depois); cada nova tentativa **renova** a marca para o próprio instante, e marca nenhuma some no
  commit: só a varredura limpa as que têm mais de 60 min. A confirmação/o apagar a gravam numa **transação
  curta própria, confirmada ANTES** do unit of work que grava no S3, depois da checagem de acesso e só nas linhas de
  quem age (intenções do próprio remetente; a versão viva que o apagar indica), **renovando** para `now()`. Sob a trava
  do objeto, antes de gravar no S3, a tentativa reconfere a própria marca (sumiu = a varredura limpou enquanto o pedido
  estava parado: 409 `storage-busy`, repetível); **nenhuma gravação no S3 sem marca**. A marca **nunca** é limpa no
  commit: só a varredura `npm run storage:reconcile` (CLI `src/storage/infra/cli/reconcile-storage.ts`, depois do `build`, no container; argumento opcional = minutos, padrão 60) a limpa, e só as mais antigas que 60 min (relógio do banco),
  depois de reparar o objeto sob a trava. `BackupObjectHealer` (objeto travado) apaga do bucket toda versão/marker que
  nenhuma versão `committed` referencia (objeto apagado: só versões com dado, os markers ficam). Roda: no próximo
  toque do objeto (marca mais antiga que a da tentativa), logo depois de um unit of work que rejeitou depois de gravar
  no S3 (inclusive COMMIT de resultado incerto: o que o COMMIT gravou é referenciado e fica) e na varredura (contexto
  `app.storage_reconcile`, policy `storage_reconcile_read` só das linhas marcadas; como toda confirmação deixa marca,
  a varredura revisita cada objeto gravado na última janela). **Só o reparo usa `ObjectStore.deleteVersion`; só a
  lixeira (`BackupTrash`, versões `purged`) usa `ObjectStore.deleteVersions`** (S3 `DeleteObjects`, até 1000 por
  chamada; nunca lança: devolve o que não saiu, e `NoSuchVersion`/`NoSuchKey` contam como apagado).
- **Controle da lixeira** (spec §4.8, "Controle da lixeira"; decisão do Jonas de 2026-11-09): status `purged` em
  `storage_object_versions` (`purged_at`, relógio do banco; migration `StorageTrashPurge`), que sai do uso, das
  listagens e dos downloads (tudo filtra `committed`; o reparo a trata como não referenciada). (1) **Esvaziar**
  (`EmptyTrashUseCase`, `POST /spaces/:spaceId/backup/trash/empty` `{ currentAuthProof }`, só token de usuário,
  `space.members.manage`, `@ThrottleReauth()`): permissão sem trava (404/403) → reautenticação (422
  `current-auth-proof-invalid`) **antes de qualquer gravação** → no unit of work, espaço FOR SHARE, até 1000 versões da
  lixeira, objetos FOR UPDATE em ordem de id, `purged` (nunca a versão viva de um objeto vivo: no SQL e em
  `TrashRules.purgeable`), auditoria `space.backup.trash_emptied` (só se apagou algo) → `{ purgedVersions, purgedBytes,
  remainingVersions }`; o app repete enquanto `remainingVersions > 0`, e um pedido que não apagou nada responde
  `remainingVersions: 0` (o laço sempre para). **Orçamento de reautenticação (decisão do controlador: a rota fica com
  `@ThrottleReauth()`, regra do projeto para toda rota que confere a senha atual):** cada volta gasta uma das 5
  tentativas por 15 min, então um Gestor apaga até **5000 versões por 15 min**; o app explica que uma lixeira muito
  grande leva várias rodadas, e o limite de 10 versões por objeto mantém a lixeira pequena no uso normal. Os delete
  markers dos objetos apagados ficam. (2) **Limite de 10
  versões antigas por objeto** na confirmação (`BackupTrash.capObject`, sob a trava do objeto, depois do
  `markSuperseded`), inclusive quando a confirmação traz de volta um objeto apagado; o apagar não aplica limite. **Ordem índice → S3:** `markPurged` grava `purged` e renova a marca do
  diário na mesma transação; o `DeleteObjects` em lote roda **depois do COMMIT**, fora da trava (`removeFromBucket`,
  nunca falha o pedido; o que não saiu fica com a marca para a varredura). Queda no meio = versão no bucket sem referência no índice, que a varredura (pela marca) ou o próximo
  toque do objeto apagam; nunca o índice apontando para uma versão apagada. Fora da trava é seguro: a versão apagada
  nunca é a atual do S3. A listagem com `since` ainda mostra a lápide cuja última versão foi `purged` (sem versão).
  `GET /spaces/:id` traz `storage.trashBytes`; recomendação ao app (avisar o Gestor acima de 80% com lixeira
  relevante; avisar que o backup parou com `space-storage-full`) em `docs/hubs/hub-lifecycle.md` §9.
- **Nunca precisar de uma segunda conexão do pool enquanto se segura uma** (autocommit "por fora" de um `uow.run`
  aberto): com o pool cheio de transações esperando travas, a espera pela conexão não tem fim e o Postgres não vê o
  impasse. Grave antes, numa transação própria.
- **Listar e baixar** (`ListObjectsUseCase`, `GetDownloadUrlUseCase`, leitor `BackupIndexReader` em SQL): `memory.read`
  = Hub com o espaço na Sala (qualquer papel; é assim que um Hub reinstalado restaura) ou qualquer membro do espaço
  (qualquer sessão, inclusive a de um Hub fora da Sala); o resto 404 `space-not-found`. **Sem trava**
  (`StorageAccess.require` / `SpaceContentAccess.requireForContent`) e sem chamada ao S3 além da assinatura.
  `GET .../objects?include=current|trash|versions&since=&objectId=&cursor=&limit=` (cursor por id, `limit` 1..1000,
  padrão 100) → `{ items, nextCursor, asOf }`: `current` = vivos com a versão atual (com `since`, o que mudou desde
  então pelo `updated_at` do objeto, lápides com `currentVersion: null`); `trash` = apagados há menos de 30 dias com a
  última versão; `versions&objectId=` = versões guardadas (viva + lixeira), com `supersededAt` e `current`. Intenção
  nunca confirmada não aparece. `asOf` = `now()` do banco na consulta; o próximo `since` é `asOf` - 1 h. **A folga é
  garantida:** confirmar/apagar gravam o objeto (`updated_at`, `deleted_at`, e `superseded_at` da versão) com
  `clock_timestamp()` **depois** de todo o trabalho no S3 e, antes dessas gravações, `uow.limitRemainingTime(
  INDEX_TAIL_TIMEOUT_MS)` (5 min, `transaction_timeout` do Postgres 17+): a transação que não confirmar até lá é
  derrubada e nunca entra (o reparo tira as cópias). Rede de segurança: o Hub faz uma **listagem completa diária**
  (sem `since`) que **substitui** o estado local, mas só apaga localmente o que ele já viu confirmado (tem um
  `versionId`) e não veio vivo; o que ainda não subiu (fila da troca de chave, envio em andamento, cópia de conflito)
  nunca é apagado por uma listagem. `POST
  .../objects/:objectId/versions/:versionId/download` → `{ url, expiresAt }` (15 min, não revogável: quem perde o
  acesso guarda só a URL que já tinha); versão desconhecida, pendente, de outro objeto ou fora da lixeira: 404
  `version-not-found`.
- **Hub e login de pessoa** (detalhe em `hubs`, "Login de pessoa pelo Hub"): `POST /hub/user-sessions` (token de Hub) abre uma
  sessão de usuário presa ao Hub (`user_sessions.hub_id`, `device_platform = 'hub'`); com ela a pessoa usa as rotas
  `/spaces/:spaceId/backup/...`, inclusive em espaço fora da Sala (leitura). A sessão cai (`hub_access_lost`) quando a
  pessoa perde todo papel no Hub (tirar papel, desvincular, sair da organização, desregistro). `/auth/login`,
  cadastro e recuperação com `platform: 'hub'` são recusados **antes de qualquer prova** (401 `invalid-credentials` no
  login; 422 `device-invalid` nos outros): sessão de Hub só nasce por essa rota.
- **S3 (LocalStack em dev, produção):** o LocalStack roda com `S3_SKIP_SIGNATURE_VALIDATION=0` (confere a assinatura
  das URLs, como o S3; veja Docker), guarda as regras de ciclo de vida mas **não as executa** (a expiração de 30 dias e
  de 1 dia não acontece em dev; o reparo e os e2e não dependem dela). O PUT provisório leva a tag `stage=upload`
  (a regra de 1 dia casa a tag, porque o filtro de prefixo só vale para o começo da chave). **Produção precisa de:**
  (1) as mesmas regras de ciclo de vida no bucket real (`.docker/localstack/init/ready.d/01-buckets.sh` é a fonte);
  (2) o papel IAM da API com `s3:ListBucket`, `s3:GetObject`, `s3:GetObjectVersion`, `s3:PutObject`,
  `s3:PutObjectTagging`, `s3:DeleteObject`, `s3:DeleteObjectVersion` e `s3:ListBucketVersions` no bucket; (3) uma
  configuração de **endpoint S3 público** para dispositivos reais em dev: as URLs assinadas saem com o host de
  `AWS_ENDPOINT_URL` (`aws:4566`), que só resolve dentro do Docker; ainda **não existe** (veja Pendências).
- **Testes:** e2e em `test/storage/` (`object-store`, `quotas`, `uploads`, `downloads`, `trash`) com o S3 do LocalStack;
  unitários ao lado do código com `ObjectStore` simulado. Helpers de Hub em `test/support/hub-client.ts` e
  `hubs-kit.ts`. Pendências do módulo: veja "Pendências antes de produção" (snapshot pago, contratação de franquia,
  classes de armazenamento mais baratas, troca de chave pelo Hub editor da Sala, visitante em Hub alheio, configuração
  inicial por Bluetooth/idioma do Hub, índice `(space_id, updated_at)`, rota de download em lote, limpeza física do
  índice, agendar `storage:reconcile`, aviso de franquia perto do fim, endpoint S3 público).

## Módulo `conversations`
`src/conversations/` (assuntos: participantes, executor, chave própria por versão, mensagens, caixa de entrada, anexos e
os feeds de sincronização; plano `docs/superpowers/plans/2026-11-09-conversations.md`). Spec:
`docs/superpowers/specs/2026-11-09-conversations-design.md`; formato em `docs/crypto/conversations.md`; RLS (participante
vivo ou executor) e "quem sai grava por último" no cabeçalho da migration `CreateConversations`. Depende de `spaces`
(`SpaceAccess`, inclusive `isSpaceMember`/`spaceMemberIds`; `SpaceStorage.lockQuota`; a porta `SpaceStorageUsage`, onde
registra a fonte `conversations`), `hubs` (`HubDirectory`: `ownerOf`,
`installedSpaceOrganization`, `lockExecutorCandidate`; `HubAccess`), `organizations` (`AuditLog`) e `storage` (a porta
`ObjectStore` e a peça compartilhada `application/object-uploads.ts`, o diário `journal.ts` e os erros
`storage-errors.ts`) e `identity` (`CurrentAuthProofVerifier`, para esvaziar a lixeira do assunto); ninguém importa
`conversations`.
- **RLS (modelo):** `org_isolation` mais policies **restritivas** por comando: participante vivo (`app.user_id` em
  `participant_user_ids`) ou executor (`executor_hub_id = app.hub_id`); as filhas consultam a conversa e nada consulta as
  filhas de volta (sem recursão, sem `SECURITY DEFINER`). `participant_user_ids` é cópia **derivada** das participações
  vivas, só escrita pelo trigger `conversation_participants_sync` (BEFORE UPDATE recusa mudança de fora). **Quem sai:** o
  trigger grava com `WHERE CURRENT OF` num cursor `FOR UPDATE` (o `SET` não lê colunas, então a linha nova não é
  reconferida pela policy de SELECT), e a lápide da participação é a **última gravação** de quem sai; depois dela só a
  própria participação e as próprias cópias (com lápide) continuam legíveis, para a sincronização dele apagar o local.
  **Efeitos de um Hub que deixa de valer** (executor nulo, lápide nas cópias) rodam sempre num contexto de **participante**
  (dono do assunto), nunca no do Hub (42501) e nunca num contexto "de confiança" que abra tudo. Colunas de identidade
  (organização, espaço, conversa, pessoa/Hub, versão da chave) são imutáveis por trigger `trg_<tabela>_immutable`
  (migration `ConversationsHardening`). Matriz completa no cabeçalho da migration `CreateConversations`.
- **Ganchos:** o `conversations` **assina** `SpaceMemberLeftHooks`, `MemberRemovedHooks` (saída da organização) e
  `SpaceQuotaHooks`/`SpaceStorageUsage` (fonte `conversations`); **recebe** `HubExecutorLostHooks` do `hubs` e **registra**
  `StorageReconcileHooks` (`conversations.attachments`, rodado pelo `storage:reconcile`); contratos em
  `src/shared/application/`, nenhum módulo importa `conversations`.
- **Rotas:** token de usuário em `/spaces/:spaceId/conversations` (`POST` cria; `/:id` lê; `/:id/participants` e
  `/:id/participants/space` compartilham; `DELETE /:id/participants/:userId` tira; `/:id/leave`; `PUT /:id/state`;
  `PUT /:id/executor`; `POST /:id/keys`; `PUT /:id/header`): a organização vem do espaço; não membro do espaço, assunto de outro espaço,
  inexistente ou sem participar = o mesmo 404 `conversation-not-found`. **Sessão aberta por um Hub** (`hubId` no
  `AuthContext`, da linha da sessão): só alcança os assuntos cujo executor é esse Hub, em toda rota de usuário dos
  assuntos (`ConversationScope.sessionHubId`, conferido em `reachable` a cada leitura/trava; o resto: o mesmo 404; criar
  só com esse Hub como executor, senão 422 `executor-invalid`) e no feed da pessoa (só esses assuntos, sem as lápides
  próprias de outros; o cliente do Hub apaga um assunto quando o feed de executor do Hub entrega a lápide da cópia
  dele). Privado é privado: um Hub, mesmo de outra pessoa, nunca lê os outros assuntos de quem entra por ele.
  Token de Hub em `/hub/conversations` (`POST`
  cria o "aviso" em nome de uma pessoa; `/:id`; `PUT /:id/state`; `POST /:id/keys`; `PUT /:id/header`): o Hub acha o assunto nas
  organizações com vínculo aprovado em que é executor. Criar com o mesmo `id` de novo = 200 com o mesmo assunto, também
  na corrida (os dois pedidos leem "não existe"; o que perde o INSERT pega o 23505 dentro do savepoint do repositório,
  relê e aplica a mesma comparação: 200 ou 409 `conversation-id-conflict`).
- **Poderes:** dono tira participante, troca executor, arquiva/reabre (`arquivado`); executor muda os estados de
  trabalho; qualquer participante compartilha e sai (403 `not-conversation-owner` para o resto). Executor = Hub cujo
  dono participa, com o espaço instalado (`hub_space` vivo, vínculo aprovado); 422 `executor-invalid`. Trocar executor
  manda as cópias de todas as versões para o Hub novo e deixa a troca de chave pendente. Troca de chave: versão atual + 1
  para **exatamente** os participantes vivos e o executor (409 `key-rotation-mismatch` com os ids); com troca pendente,
  qualquer participante ou o executor; sem ela, só o dono (409 `key-rotation-not-required`). **Corpo de 100 kB:**
  "compartilhar com o espaço" manda todas as pessoas que faltam num pedido só e passa do limite por volta de 12 versões
  × 50 pessoas (~140 bytes por cópia); o app usa o modo `people` em lotes nesse caso (`docs/app/pendencias-do-app.md`).
- **Saída** (`ConversationDeparture`, usada por sair, tirar e pelo gancho `conversations.space-member-left`): dono novo
  (participante mais antigo), executor sai junto se quem sai é dono do Hub, lápide no assunto quando sai o último,
  troca pendente, e a lápide da participação de quem sai é **a última gravação** (depois dela o assunto some no RLS).
- **Executor perdido** (`HubExecutorLostHooks`, em `src/shared/application/`, emitido pelo `hubs` no desregistro, no
  desvínculo/`HubLinkCascade` e em `RemoveHubSpace`): `executorHubId` nulo, lápide nas cópias do Hub, troca pendente,
  mensagens `pending` continuam; escrito no contexto do **dono do assunto** (nunca no do Hub: 42501), auditado
  `conversation.executor_lost`. Auditoria também de `conversation.shared`, `conversation.participant_removed`,
  `conversation.executor_changed` (só ids).
- **Ordem de locks:** Hub -> vínculo -> hub_space (FOR SHARE, `lockExecutorCandidate`) -> espaço (FOR SHARE ao criar e
  compartilhar) -> assunto (FOR UPDATE) -> participações -> **advisory lock das versões, sempre o ÚLTIMO** (só no
  COMMIT, `trg_<tabela>_sync_commit`, depois de todas as travas de linha da transação: não fecha ciclo). Ele fica preso
  do primeiro UPDATE de versão **até o fim do commit** (o resto dos triggers adiados, a trava da fila de NOTIFY, o
  flush do WAL e a réplica síncrona, se houver, e a visibilidade): **os commits que gravam nos assuntos são seriais,
  fsync incluído**. Custo conhecido: uma cascata grande (desregistrar Hub, desvincular, saída da organização com muitos
  assuntos) faz os outros que gravam nos assuntos esperarem no COMMIT, segurando a conexão do pool, pelo tempo dela
  (segundos com dezenas de milhares de linhas); a retenção grava em lotes de até 5.000 linhas
  (`CONVERSATION_RETENTION_BATCH_ROWS`). Rotas com o `lock_timeout` do storage (anexos: intenção, confirmação, apagar;
  esvaziar a lixeira) recebem a espera do COMMIT como 55P03 -> 409 `storage-busy` (e2e em `attachments.e2e-spec.ts`).
  **Proibido** `SET CONSTRAINTS ... IMMEDIATE` e commit em duas fases (`PREPARE TRANSACTION`) em transação que grava
  nessas tabelas: pegam o advisory lock antes do fim (e seguram travas de linha depois dele). Vários assuntos na mesma transação: sempre **(espaço,
  assunto) em ordem** (`idsWithExecutor`/`idsWithParticipant` ordenam por `space_id, id`; a saída da organização emite
  a saída de cada espaço em ordem de id do espaço). Ordem só pelo id do assunto dá deadlock com o executor perdido.
- **Mensagens** (`SendMessageUseCase`, `AckMessageUseCase`, `DeleteMessageUseCase`): `POST .../:id/messages`
  `{ id, keyVersion, encryptedBody, replacesMessageId? }` (pessoa em `/spaces/:spaceId/conversations`, executor em
  `/hub/conversations`), `POST /hub/conversations/:id/messages/:messageId/ack` (só o executor; outro Hub: 404
  `conversation-not-found`) e `DELETE .../:id/messages/:messageId` (só as próprias: 403 `not-conversation-owner`; 204
  idempotente; inexistente/de outro assunto: 404 `message-not-found`). Corpo cifrado ≤ 64 KiB (422 `message-too-large`).
  **Idempotência:** mesmo id + mesmo autor + mesmo conteúdo neste assunto = a mesma resposta (200, nada gravado, mesmo
  com troca pendente); qualquer outra coisa com o id (outro conteúdo/autor/assunto, ou um id que o RLS esconde:
  `insertIfAbsent` false) = 409 `message-id-conflict`, nunca "já mandada". Versão = a atual (409
  `conversation-key-version-stale`), troca pendente = 409 `conversation-key-rotation-required`. Pessoa: nasce
  `pending`; executor: nasce confirmada (CHECK). `sentAt`, `ackedAt`, lápides e `lastMessageAt` no relógio do banco
  (`clock_timestamp()` depois das travas). **Editar** = mensagem nova com `replacesMessageId` (só a própria, viva, do
  mesmo assunto: 403 / 422 `message-replaces-invalid`), e a substituída vira lápide na mesma transação. **Quem
  confirmou:** o ack grava `acked_by_hub_id` (migration `ConversationMessageAckedBy`); quando o executor troca ou se perde
  (troca de executor, `HubExecutorLostHooks`, dono do Hub saindo do assunto), `requeueAckedBy` devolve a `pending` o que
  o Hub antigo confirmou sem mandar mensagem dele depois no assunto (contexto de participante, com o assunto travado).
  Contrato do Hub (hub-lifecycle.md): executar só depois do 200 do ack; ack 404 = descartar; executor novo trata
  `pending` como trabalho.
- **Cabeçalho** (`ReplaceConversationHeaderUseCase`, `PUT .../:id/header` `{ keyVersion, encryptedHeader }` nas duas
  formas): o dono (pessoa; outro participante 403 `not-conversation-owner`) ou o executor (Hub; outro Hub 404); versão
  atual (409 `conversation-key-version-stale`), sem troca pendente (409 `conversation-key-rotation-required`). Os bytes
  do cabeçalho contam no uso como os das mensagens (trigger `trg_conversations_header_space_usage`, migration
  `ConversationHeaderUsage`, no `body_bytes` do contador; assunto com lápide conta como usado até a retenção): espaço
  `FOR SHARE` -> assunto `FOR UPDATE` -> grava -> confere (422 `space-storage-full`); criar (pessoa e Hub) também
  confere o uso depois de gravar.
- **Uso do espaço:** o corpo cifrado conta no uso (spec §4.4.1) por um contador por espaço,
  `conversation_space_usage`, mantido só pelos triggers (escrita direta do runtime: 42501, trigger `trg_<tabela>_guard` com
  `pg_trigger_depth() < 2`, migration `ConversationUsageWriteGuard`; o GRANT fica porque os triggers são SECURITY INVOKER;
  o mesmo em `conversation_attachment_usage`) `trg_conversation_messages_space_usage` (corpo guardado conta;
  com lápide, conta também como lixeira; corpo zerado pela retenção sai). É contador e não `SUM` porque as mensagens só
  são visíveis a participantes: o Gestor e o backup somariam só os assuntos deles. `ConversationStorageUsage` registra
  a fonte na porta `SpaceStorageUsage` (soma das fontes, veja `spaces`). **Travas do envio:** espaço `FOR SHARE`
  (`SpaceStorage.lockQuota`) -> assunto `FOR NO KEY UPDATE` -> grava (o trigger trava a linha do contador) -> **só então** lê o
  uso e confere (422 `space-storage-full` com `missingBytes`, a regra do backup). Envios do mesmo espaço se serializam
  no contador; a intenção de envio do backup (espaço `FOR UPDATE`) espera os envios e lê o mesmo uso. `FOR SHARE` e não
  `FOR UPDATE` para uma mensagem não esperar um lote de confirmação do backup (que segura o espaço `FOR SHARE` durante
  as cópias no S3). Apagar e ack travam só o assunto (nunca o espaço depois do contador); o ack também `FOR NO KEY
  UPDATE`. **Modos de trava do assunto** (`ConversationLockMode`): `FOR UPDATE` em toda mudança de quem está dentro,
  executor ou estado da chave; `FOR NO KEY UPDATE` no envio e no ack (serializam entre si e com o `FOR UPDATE`);
  `FOR KEY SHARE` na confirmação de anexo (só conflita com `FOR UPDATE`: troca de chave/saída esperam a cópia no S3,
  mensagens e acks não).
- **Anexos** (`RequestAttachmentUploadUseCase`, `ConfirmAttachmentUseCase`, `GetAttachmentDownloadUrlUseCase`; spec
  §4.4): o mecanismo do storage com índice próprio (`conversation_attachments`), acesso por **participação** (pessoa) ou
  **executor** (Hub), nunca por `memory.read` do espaço (o resto: o mesmo 404 `conversation-not-found`). Rotas
  `POST .../:id/attachments` `{ id, keyVersion, sizeBytes, sha256 }` (intenção: reserva 24 h, PUT assinado 15 min na chave
  provisória `orgs/<orgId>/spaces/<spaceId>/conversations/<conversationId>/uploads/<attachmentId>`, tag `stage=upload`),
  `POST .../:id/attachments/:attachmentId/confirm` (HEAD + cópia no servidor para
  `.../conversations/<conversationId>/<attachmentId>`) e `POST .../:id/attachments/:attachmentId/download` (GET assinado
  da `s3VersionId` do índice), nas duas formas (`/spaces/:spaceId/conversations` e `/hub/conversations`). Anexo ≤ 100 MiB
  (422 `attachment-too-large`), versão atual / sem troca pendente (409, na intenção e de novo na confirmação), 422
  `upload-mismatch` (com `attachmentId`), 409 `attachment-id-conflict`, 404 `attachment-not-found` (outro remetente,
  outro assunto, fora da janela, pendente no download), 409 `storage-busy`. Idempotente: o mesmo pedido de intenção =
  200 com URL nova (ou `upload: null` se confirmado); confirmar de novo = a mesma resposta. **Travas:** intenção = espaço
  `FOR SHARE` -> assunto `FOR UPDATE` -> grava -> lê o uso e confere (como a mensagem); confirmação = diário numa
  transação curta própria ANTES (`markWrite`, só o anexo pendente de quem confirma, relógio do banco) -> assunto `FOR
  KEY SHARE` -> anexo `FOR UPDATE` (a "trava do objeto") -> HEAD -> marca reconferida sob a trava (`assertStillMarked`;
  sumiu: 409 `storage-busy`) -> reparo da chave final -> cópia -> `limitRemainingTime(INDEX_TAIL_TIMEOUT_MS)` -> índice;
  `lock_timeout` de 10 s (`STORAGE_LOCK_TIMEOUT_MS`) em tudo, 55P03 = 409 `storage-busy`. Falha depois de gravar no S3 =
  reparo numa transação nova (`ConversationAttachmentHealer.repair`, contexto do reparo: quem agiu pode ter saído). Um
  pedido confirma um anexo (≤ 100 MiB), então o teto de 5 GiB por confirmação do storage vale trivialmente. A marca só
  sai pela varredura: `npm run storage:reconcile` roda também o gancho `conversations.attachments`
  (`StorageReconcileHooks`, `src/shared/application/`; a saída do CLI ganha a chave `conversations.attachments`). RLS:
  a varredura usa a mesma chave `app.storage_reconcile` (policy permissiva `conversation_attachment_reconcile_read` das
  linhas marcadas; nas restritivas, UPDATE/FOR UPDATE só da marcada; detalhe na migration
  `ConversationAttachmentStorage`). **Uso:** projeção por anexo `conversation_attachment_usage` (trigger
  `trg_conversation_attachments_space_usage`; confirmado até `purged`, lixeira = confirmado com lápide, reserva enquanto
  `reserved_until > now()`), somada na fonte `conversations` da porta `SpaceStorageUsage`; o trigger trava a linha do
  espaço em `conversation_space_usage` quando o anexo pode aumentar o uso (serializa com mensagens e outras intenções).
  `space_id` e quem enviou ficam na linha (trigger confere o espaço com a conversa). `messageId` ainda não é preenchido
  (a mensagem cita o anexo dentro do corpo cifrado). **Decisão (extração do storage):** em vez de generalizar o
  `BackupObjectHealer`/casos de uso do backup, o `storage` exporta pela `application/` só o genérico
  (`object-uploads.ts`: `removeUnreferencedVersions`, `isUploadedAsDeclared` e as constantes do mecanismo; o backup usa
  as mesmas funções) e o `conversations` tem casos de uso próprios sobre essas peças.
- **Feeds de sincronização** (`SyncConversationsUseCase` + `ConversationChangesSqlReader`; contrato completo no
  comentário do caso de uso): pessoa em `GET /conversations/changes?since=&limit=&conversationId=` (fora de
  `/spaces/:spaceId`: um cursor para todas as organizações em que é membro ativo) e executor em
  `GET /hub/conversations/changes?since=&limit=&wait=&conversationId=` (declarada antes de `/:id` no controller).
  Resposta `{ organizationIds, items: [{ type, syncVersion, deleted, data }], nextSince }`, `limit` 1..500. Padrão do
  `GET /hub/sync`: um snapshot `REPEATABLE READ, READ ONLY` por página, uma leitura por tipo e organização em sequência,
  `mergeSyncBatches` (`src/shared/domain/sync-page.ts`, a mesma fusão do Hub), lápide só com as chaves. Tipos:
  `conversation`, `conversation_participant`, `conversation_key_grant` (**só as cópias de quem lê**: nunca de outra
  pessoa ou Hub), `conversation_message` (corpo cifrado) e `conversation_attachment` (metadado, sem chave/versão do S3;
  `purged` = lápide). Escopo: pessoa = `participant_user_ids` (e, depois de sair, só as lápides da própria participação
  e cópias, pelo RLS); Hub = `executor_hub_id`, **só em organização com vínculo aprovado** (a policy do executor não
  olha o vínculo: a lista `HubDirectory.approvedOrganizationIds` é a trava). Cliente: lápide da própria participação
  (pessoa) / da própria cópia (Hub: só some quando ele deixa de ser executor) = apagar o assunto local; organização
  fora de `organizationIds` = apagar os assuntos dela; assunto que **entra no escopo** (compartilhado, executor de novo)
  = buscar com `conversationId=<id>&since=0`. **Assunto com lápide** (movido, ou o último saiu): os feeds entregam só a
  lápide dele, nunca os filhos (mensagens, anexos, participações, cópias), nem numa sincronização completa; um assunto
  movido mantém executor e cópias vivas, e o filtro é o que impede reentregá-los. Linhas próprias de um assunto que o
  leitor não vê mais (saiu, deixou de ser executor) continuam saindo como lápides. **Versão no COMMIT (sem a ressalva
  "ordem de commit × `sync_version`"):** nas cinco tabelas dos feeds a versão é dada **no COMMIT, na ordem dos commits**
  (migration `ConversationFeedCommitOrder`, helper `addCommitOrderedSyncVersion`, que substituiu a versão por xid de
  `ConversationFeedSafeHorizon`): toda gravação deixa a linha provisória (`sync_pending = true`, trigger
  `trg_<tabela>_zz_sync_version` -> `mark_sync_pending`; o `zz` o mantém o ÚLTIMO BEFORE trigger: trigger BEFORE novo
  nessas tabelas precisa ordenar antes dele), e o constraint trigger adiado `trg_<tabela>_sync_commit` pega **um** advisory lock de transação
  (`CONVERSATION_SYNC_FEED.lockKey`) e dá a versão de **uma** sequência (`conversation_sync_version_seq`). O Postgres
  torna o commit visível antes de soltar as travas, então quem viu a versão V viu toda linha confirmada com versão
  <= V: o leitor serve só `sync_pending = false`, sem horizonte, sem segurar página, sem depender de outra transação do
  banco (uma transação longa em outro lugar não atrasa nada), de xid ou do cluster; versões únicas (sem empate, sem
  limite de linhas por transação). O UPDATE do commit roda no contexto que a transação tiver no fim e pode mexer em
  linha que quem gravou já não vê (quem sai, o último participante, executor perdido, retenção): passa pelo escape
  `sync_commit_in_progress()` (`app.sync_commit` só durante esse UPDATE e `pg_trigger_depth() > 0`), OR nas policies
  restritivas de SELECT/UPDATE e policies permissivas `sync_commit_read`/`sync_commit_update`; nele o
  `mark_sync_pending` mantém a linha inteira e só muda `sync_version`/`sync_pending`. **Policy nova ou recriada nessas
  tabelas precisa manter o escape** (sem ele o UPDATE do commit muda 0 linhas e a linha fica `sync_pending` para
  sempre, fora dos feeds; fixado por `test/conversations/commit-order-invariants.e2e-spec.ts`, e o reset e o teardown
  dos e2e falham se sobrar linha confirmada `sync_pending`: `test/setup/commit-order-check.ts`); trigger AFTER novo que trava ou grava precisa de `UPDATE OF` ou
  `WHEN (NEW.sync_pending)` (como `trg_conversation_participants_sync`), senão roda no commit, depois do advisory lock.
  Os triggers de uso (`UPDATE OF`) não contam duas vezes; os de NOTIFY disparam de novo (o Postgres junta e entrega no
  COMMIT, já com as versões). **Edição:** a mensagem nova é gravada ANTES da lápide da substituída (`sync_version` menor), então uma
  página nunca entrega a lápide sem a substituta.
- **Sondagem longa do executor** (`wait` 0..25 s): **nunca segura conexão do pool nem transação enquanto espera.** Laço:
  inscreve no sinal -> lê a página numa transação curta -> vazia: espera FORA de unit of work (wake, prazo ou o Hub
  desligar: `close` da resposta) -> inscreve e relê. Sinal: triggers `pg_notify('conversation_changes', <hubId>)`
  (migration `ConversationChangeNotify`: `conversations` avisa o executor novo e o antigo; cópias de Hub avisam o Hub;
  o resto avisa o executor do assunto) e **uma** conexão `LISTEN` por processo (`PgConversationChangeSignal`, fora do
  pool, login de runtime, aberta na primeira sondagem), espalhada em memória por Hub. NOTIFY é só dica: a resposta é
  sempre releitura por `sync_version` (perdeu o aviso: a releitura no prazo entrega; sem a conexão LISTEN, relê a cada
  5 s; reconectou: acorda todos). Limites por instância (`LongPollSlots`): 2 sondagens por Hub e 1000 no total; acima
  disso responde na hora, sem esperar. No desligamento, as esperas respondem o que leram.
- **Mover, apagar anexo, lixeira e retenção** (spec §4.2, §4.4.1; Task 7):
  - **Mover** (só o dono, pelo app, em dois passos): criar no destino com `movedFrom: { spaceId, conversationId }`
    (`CreateConversationUseCase`: dono do antigo, membro dos dois espaços, outro espaço; 403 `not-conversation-owner`,
    404 `conversation-not-found`, 422 `conversation-move-invalid`; o executor é validado no destino; o app reenvia
    mensagens e anexos cifrados com a chave nova e compartilha só com membros do destino, os outros dão 422
    `participant-not-space-member`) e depois `POST /spaces/:spaceId/conversations/:id/move` `{ toSpaceId,
    toConversationId }` (`MoveConversationUseCase`, 204, idempotente): o novo precisa ter `movedFromConversationId` = o
    antigo (422 `conversation-move-invalid`); o antigo ganha lápide (participações, cópias e executor ficam; a sincronização
    entrega a lápide) e auditoria `conversation.moved` (só ids). Trava só o antigo.
  - **Apagar anexo** (`DeleteAttachmentUseCase`, `DELETE .../:id/attachments/:attachmentId` nas duas formas): só quem
    enviou (403), 204 idempotente, 404 `attachment-not-found`; lápide: confirmado vira lixeira, pendente solta a
    reserva. `messageId` continua nulo: o app apaga a mensagem e os anexos dela (a referência está no corpo cifrado).
  - **Esvaziar a lixeira do assunto** (`EmptyConversationTrashUseCase`, `POST .../:id/trash/empty`
    `{ currentAuthProof }`, `@ThrottleReauth()`): só o dono (não participante, inclusive o Gestor: 404; participante:
    403, antes do Argon2), reautenticação antes de gravar, assunto FOR UPDATE -> corpos com lápide zerados -> até 1000
    anexos com lápide `purged` (FOR UPDATE em ordem de id, marca do diário renovada) -> auditoria
    `conversation.trash_emptied` -> COMMIT -> `DeleteObjects` (`removePurgedAttachments`; o que falhar fica marcado para
    o `storage:reconcile`). `{ purgedMessages, purgedAttachments, purgedBytes, remainingAttachments }`. O esvaziar do
    Gestor (backup) nunca toca os assuntos.
  - **Retenção** (`ConversationRetention` + `ConversationRetentionSqlStore`, CLI `npm run conversations:retention`):
    tudo com lápide há mais de 30 dias (`CONVERSATION_RETENTION_DAYS`, relógio do banco; lápide da mensagem/anexo, ou a
    do assunto para tudo dele): corpos zerados (mensagem de assunto com lápide ganha a lápide do assunto, CHECK), anexos
    `purged` com marca renovada e o cabeçalho zerado; um lote por transação (até `CONVERSATION_RETENTION_BATCH_ROWS` =
    5.000 corpos + anexos de um assunto, repetido enquanto o lote vier cheio; o cabeçalho no último; assunto FOR UPDATE
    -> linhas -> contador; nunca o espaço), S3 depois do COMMIT. Os triggers de uso tiram os bytes (mensagem de assunto com lápide
    conta como usada, não lixeira, até a retenção). **Roda com o login DONO** (`typeOrmOptions('migration')`, aberto
    só pelo CLI; a API nunca segura essa conexão): assunto cujo último participante saiu é invisível a todo contexto de
    runtime e o trigger de uso precisa vê-lo; o dono precisa ignorar o RLS (Pendências). **Antes de tudo confere**
    `rolsuper OR rolbypassrls` do login (`bypassesRowSecurity`): sem isso falha com `RetentionLoginError` e o CLI sai
    com código 1 (nunca um "nada a fazer" silencioso). Idempotente; erro num assunto é registrado, a rotina segue e o
    CLI sai com código 1 (`failed > 0`).
  - **`storage.trashBytes`** (`GET /spaces/:id`) inclui a lixeira dos assuntos, que só os donos (ou a retenção) esvaziam;
    decisão: documentar (app avisa, `docs/app/pendencias-do-app.md`) em vez de separar o número.
- **Testes:** e2e em `test/conversations/` com a cripto real (`test/support/conversation-crypto.ts`) e os helpers de
  `test/support/conversations-kit.ts` (criar/compartilhar/trocar chave/mandar/confirmar/apagar pela HTTP, pessoas em
  lote, estado cru: `messageRows`, `conversationSpaceUsage`, `lastMessageAt`).

## Módulo `cloud`
`src/cloud/` (nuvem ativa). Spec: `docs/superpowers/specs/2026-11-10-active-cloud-design.md`; plano
`docs/superpowers/plans/2026-11-10-active-cloud.md` (em execução; a seção completa entra no fim do plano).
- **Chave do servidor** (`ServerKeyring`, `application/ports/server-keyring.ts`; `KmsServerKeyring` em `infra/crypto/`):
  par X25519 numa linha de `cloud_server_keys` (dado do servidor: sem organização nem RLS), privada **só cifrada pelo
  KMS** (`CLOUD_KMS_KEY_ID`, contexto `{ purpose: 'server-x25519-private-key-v1', publicKey }`), gerada no primeiro uso
  (advisory lock entre instâncias), aberta em memória num campo privado, conferida contra a pública e apagada
  (`memzero`) no `onApplicationShutdown`. KMS que recusa = erro, **nunca** um par novo. O runtime só pode mudar `retired_at`.
  `openSealed(copy)` abre `0x01 ‖ crypto_box_seal` (108 chars; atual, depois as aposentadas) e devolve os 32 bytes (quem
  chama apaga); malformada ou que não abre: o mesmo 422 `server-copy-invalid`. **Rotação** (vale com várias instâncias rodando): material
  da chave KMS = rotação automática do KMS (transparente); par novo = `retired_at` na linha atual. Cada instância relê qual
  é a atual a cada `SERVER_KEY_CURRENT_TTL_MS` (60 s; a primeira a reler cria o par novo, sob o advisory lock), então em
  até 60 s todas entregam a pública nova; uma cópia que não abre com as chaves em memória relê as linhas e abre as que
  faltam, então a cópia selada para o par novo abre na hora em qualquer instância. As cópias do par aposentado continuam
  abrindo até a nuvem reselar para a pública nova. `GET /cloud/server-key` -> `{ publicKey }` (qualquer
  usuário autenticado). e2e em `test/cloud/` (KMS do LocalStack).
- **Embeddings** (`Embedder`, `application/ports/embedder.ts`; `OllamaEmbedder` em `infra/embeddings/`): serviço `embeddings` do
  compose (`ollama/ollama:0.40.16`, modelo `nomic-embed-text:v1.5` = id `0a109f422b47`, o mesmo `nomic-embed-text:latest` do Hub; baixado
  na primeira subida para `.docker/ollama/models`, ~274 MB; `.docker/ollama/start.sh`). `embed(textos, 'document'|'query')` ->
  `{ vectors (768), model, dimensions, inputTokens }`, em lotes de 32 por `POST /api/embed` (`truncate: false`: texto longo demais é 400, nunca cortado em silêncio). Falha = `EmbeddingServiceError` (porta) com `retryable` (rede, timeout, 5xx, 429: sim; 4xx e resposta fora do formato: não). **Sem prefixo de tarefa, de propósito:**
  o Hub (`index_docs.py`) embute sem prefixo; usar `search_document:`/`search_query:` é mudança **conjunta com o Hub + reindexação
  completa dos dois lados** (o `kind` existe na porta para esse dia). O Hub usa o `/api/embeddings` antigo (sem normalizar);
  o `/api/embed` normaliza: mesma direção (cosseno 1,0 medido), e só usamos cosseno. Teste contra o serviço real:
  `docker exec -e EMBEDDINGS_REAL_URL=http://embeddings:11434 vaulter-back-app npx vitest run src/cloud/infra/embeddings/ollama-embedder.real.spec.ts`
  (pulado sem a variável; **o CI não baixa o modelo**, os e2e usam o `FakeEmbedder` por DI).
- **Modelo de linguagem** (`LanguageModel`, `application/ports/language-model.ts`): `complete({ system, messages, tools?, maxTokens })` ->
  `{ text, toolCalls, stopReason, usage, model }`, um turno por chamada (com `toolCalls` o chamador roda e chama de novo).
  `BedrockLanguageModel` (`infra/bedrock/`, Converse API, `us-east-1`, papel IAM, sem endpoint do LocalStack) escolhido por
  `CLOUD_LLM_DRIVER` (`bedrock`|`fake`); `CLOUD_LLM_MODEL_ID` precisa ter preço. Falha = `LanguageModelError` (`retryable`: throttling, 5xx, erro de rede), só
  o nome do erro, nunca o prompt. Histórico com blocos de ferramenta exige repassar `tools` em todo turno (Converse recusa sem
  `toolConfig`): sem elas, `LanguageModelError` não retentável antes de chamar. `fake` é recusado com `NODE_ENV=production` (env e módulo). Falsos determinísticos em `src/cloud/testing/` (`FakeEmbedder` bag-of-words 768 dim;
  `FakeLanguageModel` com turnos roteirizados `enqueue({ toolCalls })` e uso computado), trocados por DI nos e2e.
- **Preço** (`AiPricing`, `domain/ai-pricing.ts`): tabela em código, micro-USD por milhão de tokens (`bigint`), conta com
  arredondamento **para cima** por chamada; modelo sem preço = `UnpricedModelError` (falha fechada; o `CloudModule` confere `CLOUD_LLM_MODEL_ID` e `EMBEDDING_MODEL` **na subida**). Valores atuais são
  **provisórios** (Jonas decide); embedding próprio tem custo nominal de US$ 0,02/MTok para a indexação consumir o orçamento.

## Banco de dados (TypeORM + migrations)
- **Pool:** o do driver `pg`, com tamanho explícito `DB_POOL_MAX_CONNECTIONS` (10 por instância; instâncias × (10 + 1 da conexão LISTEN dos assuntos + 4 do pool do pg-boss, `JOB_QUEUE_POOL_MAX`) abaixo
  do `max_connections` do banco) e `connectionTimeoutMillis` = `DB_POOL_CONNECTION_TIMEOUT_MS` (10 s), ambos em
  `typeorm.options.ts`: pool esgotado vira erro (500, transações desfeitas) em vez de travar a API. Trabalho longo
  segurando conexão precisa de teto (ex.: o backup limita o lote da confirmação e a espera por trava, veja `storage`).
- **TypeORM 1.x** + `@nestjs/typeorm`, driver `pg`. Config de conexão em `src/database/typeorm.options.ts`,
  compartilhada entre a aplicação (`DatabaseModule`) e o CLI (`src/database/data-source.ts`). Variáveis do
  `.env` (`DB_*`) são carregadas pelo `ConfigModule` (app) e por `process.loadEnvFile` (CLI).
- **Toda tabela tem `created_at`, `updated_at` e `deleted_at`**, vindos de uma entidade base (`@CreateDateColumn`,
  `@UpdateDateColumn`, `@DeleteDateColumn`). **Offline-first:** o que o hub/app sincronizam nunca sofre
  `DELETE` físico — excluir é `softDelete()` (lápide); tabela de ligação que volta a existir tem o
  `deleted_at` limpo, não uma linha nova. Essas tabelas têm também `sync_version` (nas dos assuntos, dada no COMMIT:
  `addCommitOrderedSyncVersion`; nas outras, sequência global do
  servidor, por trigger); o endpoint de sincronização usa `withDeleted` para mandar as lápides. Regras
  completas no cabeçalho de `docs/der_model.sql`.
- **Dois logins no Postgres:**
  - **runtime** (`DB_APP_USERNAME`/`DB_APP_PASSWORD`, padrão `vaulter_app`): o que a API usa. Sem superusuário,
    sem `BYPASSRLS`, membro do papel de grupo `app_runtime`, que tem só `SELECT, INSERT, UPDATE` — **sem
    `DELETE`** (reforça o soft delete; a limpeza de lápides decide isso depois). As permissões vêm das migrations;
    o login é criado por `.docker/postgres/init/02-app-role.sh` (idempotente);
  - **dono** (`DB_USERNAME`): migrations, CLI, compose, pgAdmin e a preparação do banco de teste.
  - Em banco **já existente** (criado antes do script), rodar uma vez:
    `docker exec vaulter-back-db sh /docker-entrypoint-initdb.d/02-app-role.sh`
- **Helpers de migration** (`src/shared/infra/db/migration-helpers.ts`): `addSyncVersionTrigger(qr, tabela)` (coluna
  `sync_version`, índice e trigger da sequência global) e `enableOrganizationRls(qr, tabela)` (RLS com `FORCE` e
  policy por `app.organization_id`; sem contexto, nenhuma linha é visível). Em código, o contexto vai por transação:
  `runInOrganizationScope(dataSource, orgId, work)` ou, nos repositórios de dado de cliente, estendendo
  `OrganizationScopedRepository` (todo método recebe `organizationId` e filtra por ele; o RLS é a segunda trava).
  **Testes de RLS precisam passar pelo login de runtime** — o dono é superusuário e ignora RLS.
- **Unit of work** (`src/shared/infra/db/unit-of-work.ts`, provider global do `DatabaseModule`): caso de uso que
  grava em mais de um repositório (inclusive de outro módulo) envolve o trabalho em `await uow.run(async () => ...)`
  — uma transação só. O `EntityManager` da transação viaja num `AsyncLocalStorage`; os repositórios o pegam com
  `currentManager(dataSource)` (fora de `run`, é o `dataSource.manager`, em autocommit como antes).
  - **Erro que sai do `run` desfaz tudo.** `run` aninhado abre um **savepoint**: se falhar, só ele é desfeito e o
    erro sobe; quem capturar pode seguir. **Não engolir erro de repositório dentro de um `run` sem um `run`
    aninhado** — a transação fica abortada e o `run` externo rejeita com `25P02` (há uma sonda antes do COMMIT
    para isso não virar ROLLBACK silencioso).
  - Efeitos pós-commit (fila pg-boss, e-mail, chamadas externas) vão **depois** do `run`, não dentro.
  - `uow.limitRemainingTime(ms)` (`transaction_timeout`, contado a partir da chamada, inclusive ocioso): passou, o
    Postgres derruba a conexão e a transação nunca confirma (o `run` rejeita). Para limitar a cauda entre um carimbo
    de relógio e o COMMIT (ex.: o `since` do backup). **Pressupõe `transaction_timeout` = 0 no servidor e nos papéis**
    (o padrão): um valor global contaria desde o começo da transação e derrubaria lotes longos do backup antes da
    cauda (não configurar no banco gerenciado sem rever isto). `uow.setLockTimeout(ms)` faz o mesmo com `lock_timeout`
    (espera por trava; 55P03, `isLockTimeout`).
  - Contexto do RLS: `uow.setContext({ organizationId?, userId?, hubId? })` grava `app.organization_id` /
    `app.user_id` / `app.hub_id` (Hub autenticado)
    (`set_config(..., true)`) até o fim da transação; fora de `run` lança erro. Para trocar só num trecho (ex.:
    gravar na organização pessoal e na do convite na mesma transação), use `uow.withContext(ctx, work)` ou
    `runInOrganizationScope`: dentro de um `run`, entram nele num savepoint e restauram o contexto anterior ao sair.
    Chaves que abrem uma linha só (`invitationTokenHash`, `hubSigningPublicKey` -> `app.hub_signing_public_key`,
    busca do Hub pela chave de assinatura) entram só por `withContext`, nunca por `setContext`.
  - RLS dos Hubs (matriz no cabeçalho da migration `CreateHubs`): `hubs` não tem `organization_id`; o dono lê
    `hub_organization` pela coluna desnormalizada `hub_owner_user_id` (FK composta com `hubs (id, owner_user_id)`),
    porque a policy de `hubs` consulta `hub_organization` e uma policy que consultasse `hubs` de volta daria
    recursão. Escrita em `hub_organization`/`hub_space` só no escopo da organização da linha (os repositórios põem).
- **Banco de teste:** os e2e rodam em `DB_TEST_DATABASE` (padrão `${DB_DATABASE}_test`), criado e migrado pelo
  `globalSetup`; o banco de desenvolvimento nunca é truncado.
- **Enums do DER** viram `varchar` + `CHECK` (alterar enum nativo depois é caro). **Índices únicos parciais**
  (ex.: `WHERE deleted_at IS NULL`) são declarados nos metadados da entidade, para o `migration:generate` não
  acusar diferença.
- **`synchronize` é sempre `false`** — o schema só muda por migration, nunca ligar sincronização automática.
- **Entidades:** arquivos `*.entity.ts` em `infra/db/` do módulo (só a entidade TypeORM usa esse sufixo), registrados com
  `TypeOrmModule.forFeature([...])` no módulo (a app usa `autoLoadEntities`). O CLI acha as entidades pelo
  glob `**/*.entity.js`, então o sufixo `.entity.ts` é obrigatório.
- **Migrations** ficam em `src/database/migrations/` e são versionadas. Rodar **dentro do container**
  (o host `db` só resolve lá):
  ```bash
  npm run migration:generate -- NomeDaMudanca   # gera a partir da diferença entidades × banco
  npm run migration:create -- NomeDaMudanca     # cria migration vazia (SQL manual, ex.: índices pgvector)
  npm run migration:run                         # aplica pendentes
  npm run migration:revert                      # desfaz a última
  npm run migration:show                        # lista e status
  ```
- O CLI roda sobre código **compilado**: os scripts compilam `src/` para `dist/typeorm/` antes de chamar o
  `typeorm` (o projeto é ESM e as entidades dependem de `emitDecoratorMetadata`, que só o `tsc` gera).
  Migrations geradas já saem formatadas pelo Prettier.
- Sempre revisar o SQL gerado antes de rodar, e escrever o `down` de migrations manuais.
- A entidade TypeORM deve descrever **todas** as constraints (CHECK, índices, únicos parciais) nos metadados: depois
  de uma migration, `migration:generate` precisa sair vazio. `npm run schema:check` (`scripts/schema-check.sh`, roda
  no CI depois do `migration:run`) automatiza isso: falha se o `schema:log` do TypeORM imprimir qualquer SQL contra
  o `DB_DATABASE` migrado.

## Variáveis do `.env` (além das de infraestrutura do compose)
Validadas na subida por `src/shared/infra/config/env.validation.ts` (faltou ou inválido: a API não sobe).
| Variável | Para quê | Padrão |
|---|---|---|
| `DB_APP_USERNAME` / `DB_APP_PASSWORD` | login de runtime da API (veja Banco de dados) | `vaulter_app` (dev) |
| `DB_TEST_DATABASE` | banco dos e2e | `${DB_DATABASE}_test` |
| `PROBLEM_TYPE_BASE_URL` | base das URLs `type` dos erros | obrigatória |
| `API_DOCS_TITLE` / `API_DOCS_INTERNAL_ENABLED` | título do Swagger / liga a doc interna | obrigatória / `false` |
| `LOG_LEVEL` / `LOG_PRETTY` | nível do pino / saída legível | `info` / `false` |
| `SENTRY_DSN` / `SENTRY_ENVIRONMENT` / `SENTRY_TRACES_SAMPLE_RATE` | Sentry (sem DSN, desligado) | vazio / `development` / `0` |
| `AUTH_JWT_ISSUER` | `iss` dos tokens | obrigatória |
| `AUTH_JWT_AUDIENCE` | `aud` dos tokens de acesso (validado na verificação) | obrigatória |
| `AUTH_JWT_KEY_ID` | `kid` do cabeçalho do JWT | obrigatória |
| `AUTH_JWT_SIGNING_SEED` | semente Ed25519 (32 bytes em base64url) — **segredo** | obrigatória |
| `AUTH_JWT_PREVIOUS_KEYS` | chaves antigas só para **verificar**, `kid:seed[,kid:seed...]`, sem espaços (rotação) | vazio |
| `AUTH_ACCESS_TOKEN_TTL_SECONDS` | validade do access token | `900` |
| `AUTH_REFRESH_TOKEN_IDLE_DAYS` | inatividade máxima do refresh | `30` |
| `IDENTITY_DECOY_SALT_KEY` | chave do salt falso do pré-login (32 bytes em base64url) — **segredo** | obrigatória |
| `IDENTITY_RECOVERY_HASH_KEY` | chave (BLAKE2b com chave) do hash da prova do código de recuperação (32 bytes em base64url) — **segredo**; trocar invalida **todos** os códigos | obrigatória |
| `HUB_CODE_HASH_KEY` | chave (BLAKE2b com chave) do hash do código de reivindicação e do desafio do Hub (32 bytes em base64url) — **segredo**; trocar invalida códigos e desafios pendentes | obrigatória |
| `TRUST_PROXY` | confiança em `X-Forwarded-For`: `false`, nº de saltos ou lista de IPs/CIDRs (`true` só em dev; veja abaixo) | `false` |
| `ARGON2_MAX_QUEUE` | fila máxima do pool do Argon2id; cheia, responde 503 (inteiro >= 1) | `threads × 64` |
| `RATE_LIMIT_ENABLED` | liga o rate limit (os e2e rodam com `false`) | `true` |
| `ARGON2_POOL_SIZE` | threads do pool do Argon2id (inteiro >= 1) | `min(4, núcleos)` |
| `AWS_REGION` / `S3_BUCKET_HUB_BRAIN` | região e bucket (versionado) do storage | obrigatórias |
| `AWS_ENDPOINT_URL` | endpoint do S3 (LocalStack em dev; vazio em produção) | vazio |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | credenciais estáticas, as duas ou nenhuma (sem elas, papel IAM) | vazio |
| `S3_FORCE_PATH_STYLE` | path-style (obrigatório no LocalStack) | `false` |
| `CLOUD_KMS_KEY_ID` | chave KMS (id, ARN ou `alias/...`) que envelopa a privada X25519 do servidor (módulo `cloud`) | obrigatória |
| `EMBEDDINGS_URL` / `EMBEDDING_MODEL` | serviço de embeddings (Ollama) e o modelo (tag fixada, gravado em cada trecho) | `http://embeddings:11434` / `nomic-embed-text:v1.5` |
| `CLOUD_LLM_DRIVER` / `CLOUD_LLM_MODEL_ID` | `bedrock` ou `fake` (dev sem Bedrock); id/perfil do Claude no Bedrock (precisa de preço em `AiPricing`) | `bedrock` / `us.anthropic.claude-sonnet-5-5` |
| `JOB_WORKERS_ENABLED` | este processo roda workers do pg-boss (busca, manutenção, cron); `send` funciona sempre | `true` |

Os valores do `.env.example` para os segredos são **só de desenvolvimento**; produção gera os próprios:
`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.

## Pendências antes de produção
- JWKS público para o hub validar tokens offline.
- Hubs: WebSocket hub ↔ backend (hoje só HTTP com sondagem); apagamento remoto do Hub; transferência de Hub
  (atualizar `hub_organization.hub_owner_user_id`); ação de admin que tira da Sala todas as liberações de uma
  organização; consulta de status por Hub atrás de NAT (o limite é por IP); limpeza física das linhas antigas de
  `hub_enrollments`, `hub_link_codes`, `hub_auth_challenges` e desafios falsos (o runtime não tem `DELETE`; hoje a
  apresentação vencida só vira `expired`, e códigos/desafios usados ficam; `expireStale` roda a cada apresentação).
- **Ordem de commit × `sync_version`:** a versão é atribuída na escrita, não no COMMIT; uma transação com versão menor
  que confirma depois de outra com versão maior pode ser pulada para sempre pelo `nextSince` da sincronização do Hub
  (o `REPEATABLE READ` só deixa cada página coerente). Opções: horizonte seguro (guardar `pg_current_xact_id()` numa
  coluna xid8 junto da versão e só servir linhas abaixo de `pg_snapshot_xmin(pg_current_snapshot())`) ou carimbo de
  versão no momento do commit. Mitigação até lá: sincronização completa periódica do Hub. O mesmo vale para o `since`
  da listagem do backup (os feeds dos assuntos **não** têm mais a ressalva: versões dadas no COMMIT, na ordem dos
  commits, veja o módulo `conversations`; as tabelas do `GET /hub/sync` podem adotar o mesmo helper
  `addCommitOrderedSyncVersion` com um `CommitOrderedSyncFeed` próprio, sem o horizonte por xid, que parava os feeds com
  qualquer transação longa do cluster, quebrava num restore lógico e empatava acima de 65.535 linhas por transação), mas
  na listagem do backup a distância entre o carimbo (`clock_timestamp()`, depois do S3) e o
  COMMIT é limitada a 5 min (`limitRemainingTime`), dentro da folga de 1 h do `since`.
- **Índice `storage_objects (space_id, updated_at)`** para o `since` da listagem do backup (hoje filtra sem índice, pelo
  índice do espaço + PK); entra numa migration quando os espaços crescerem.
- **Storage/backup:** snapshot pago (versão do espaço inteiro numa data); contratação de franquia pela organização com
  cobrança automática (hoje só o financeiro da plataforma ajusta `storage_quota_bytes`); classes de armazenamento mais
  baratas (ex.: Infrequent Access/Glacier para a lixeira e versões antigas); **troca de chave feita pelo Hub editor da
  Sala** (opção b da spec: hoje só um membro pelo app troca, e o Hub guarda os envios numa fila local enquanto a troca
  está pendente); visitante em Hub alheio (pessoa de outra organização usando o Hub); configuração inicial do Hub por
  Bluetooth e idioma; rota de download em lote (hoje uma URL por versão); limpeza física do índice
  (`storage_objects`/`storage_object_versions` depois da lixeira; o runtime não tem `DELETE`); aviso de franquia perto
  do fim (notificação); endpoint S3 público configurável para dispositivos reais em dev.
- Exclusão de conta (LGPD) precisa revogar as sessões.
- **Nuvem ativa / KMS:** criar a chave KMS simétrica real (`us-east-1`, rotação automática ligada) e o alias de
  `CLOUD_KMS_KEY_ID`; papel IAM da API com `kms:Encrypt` e `kms:Decrypt` nela. Sem nome de produto no alias.
- **Nuvem ativa / Bedrock:** habilitar o acesso ao modelo Claude no Bedrock (`us-east-1`) e dar ao papel IAM da API `bedrock:InvokeModel` no
  modelo/perfil de `CLOUD_LLM_MODEL_ID`; em produção o serviço de embeddings precisa de um host próprio (o compose é só dev).
- **Assuntos (`conversations`), pendências:** notificações (mensagem nova, pedido de "sim", compartilhado: hoje só
  aparecem pelo feed); nuvem ativa e **executor na nuvem** (hoje o executor é sempre um Hub); API de integradores
  (o assunto como caixa de entrada de apps); WebSocket no lugar da sondagem longa do executor; reconcile do **contador**
  `conversation_space_usage` (os triggers o mantêm, mas não há varredura que corrija uma deriva); **limite de lote** no
  esvaziar das mensagens do assunto (`purgeTrash` das mensagens zera tudo de uma vez; os anexos já vão em 1000);
  `move` que completa uma segunda cópia movida sem auditar; índice parcial por `deleted_at` para a retenção.
  **LISTEN:** a conexão `PgConversationChangeSignal` não tem `keepAlive`/ping (meia-aberta = acorda por prazo, até 25 s) e
  reconectar acorda todos de uma vez (sem jitter); **não funciona atrás de pgbouncer em modo transação** (LISTEN exige
  conexão de sessão). **Pool:** a conexão do LISTEN fica fora do pool, então conte `instâncias × (DB_POOL_MAX_CONNECTIONS
  + 1)` (hoje 10 + 1) ao dimensionar `max_connections` do Postgres.
- **Agendar `npm run conversations:retention`** (1x por dia, fora da aplicação, ANTES do `storage:reconcile`, que
  apaga do bucket o que o `DeleteObjects` dela deixou) até o pg-boss entrar. Sem ela, o conteúdo apagado dos assuntos
  fica para sempre (conta no uso do espaço). **Login:** roda com o dono (`DB_USERNAME`), que só ignora o RLS sendo
  superusuário ou com `BYPASSRLS`; no Postgres gerenciado (dono sem superusuário e com `FORCE ROW LEVEL SECURITY`), criar
  um papel de manutenção com `BYPASSRLS` para ela (ou um contexto de confiança `app.conversation_retention` nas
  policies, como o `app.storage_reconcile`). As consultas da retenção varrem `conversations` (sem índice por
  `deleted_at`): índice parcial quando crescer.
- **Agendar `npm run storage:reconcile`** (1x por dia, fora da aplicação) até virar uma tarefa agendada do pg-boss (a
  fila já existe, `JobQueue`; falta a tarefa). Sem a varredura, um objeto que ninguém toca de novo depois de uma queda entre o S3 e o COMMIT pode ter a versão
  do índice expirada pelo ciclo de vida em 30 dias.
- Plataforma: quarentena/aviso por e-mail ao dono e aos admins quando a equipe age numa organização ou Hub; leitura da
  auditoria da organização pelo cliente (hoje só se grava); endurecer a aprovação dupla (hoje basta outra pessoa com
  `platform.support.approve`); demais permissões de financeiro, tickets e chat (o `platform_finance` só tem `platform.billing.storage_quota`).
- Recuperação de conta, limites conhecidos: (a) as escritas em `users` são por campo (`updatePasswordMaterial`,
  `updateRecoveryCode`) e a recuperação reconfere a prova sob `FOR UPDATE` (`findByIdForUpdate`), então trocar o código
  durante uma recuperação nunca é desfeito; mas `PUT /me/password` não trava a linha, e um que passou na reautenticação
  logo antes de uma recuperação confirmar ainda pode sobrescrever a senha recuperada (corrida estreita; a sessão dele
  já foi revogada pela recuperação); (b) confirmação por e-mail, aviso ao dono da conta e auditoria visível da
  recuperação ficam para depois.
- Organizações: avisar admins por notificação (convite aceito, membro saiu); exclusão de organização; papéis
  próprios (modo avançado: `role_permission` com RLS por organização, hoje o catálogo é só leitura); quem sai e volta mantém
  o `joinedAt` original (o vínculo é reativado, não recriado); trava de assentos quando houver limites (`SeatPolicy`).
- Espaços: quem sai do espaço e volta também mantém o `joinedAt` original (a atribuição em `role_assignments` é
  reativada, não recriada); **assinar cada versão da chave** com a Ed25519 de quem fez a troca e o app conferir as
  chaves públicas dos membros antes de trancar (proteção contra um servidor malicioso ativo, que hoje poderia
  injetar uma chave pública ou uma versão forjada). (O storage já recusa envio
  enquanto `keyRotationRequired`: 409 `space-key-rotation-required`.)
- Limites residuais conhecidos do rate limit (veja a seção abaixo): janela fixa (rajada de até 2x na virada),
  dependência da ordem dos guards, falha fechada com o Postgres fora do ar e bloqueio do e-mail da vítima.

## Rate limit
- `@nestjs/throttler` com guard global (`AppThrottlerGuard` em `ThrottlingModule`, registrado **depois** do
  `IdentityModule`, do `HubsModule` e do `PlatformModule` para os guards de token e a trava da plataforma rodarem
  antes — fixado por e2e) e storage no Postgres
  (`PostgresThrottlerStorage`, upsert atômico; várias instâncias dividem os contadores). Chave por IP (`req.ip`,
  respeita `TRUST_PROXY`; IPv6 agrupado no /64), por e-mail normalizado no login e nas rotas de recuperação de conta, e
  por usuário nas rotas de reautenticação.
- Limites (`src/shared/infra/http/rate-limits.ts`):
  | Rota | Limite |
  |---|---|
  | qualquer rota sem limite próprio | 300/min por IP, **somando todas as rotas** |
  | `POST /auth/prelogin` | 30/min por IP |
  | `POST /auth/register` | 10/h por IP |
  | `POST /auth/login` | 10/min por IP **e** 5/min por e-mail normalizado |
  | `POST /auth/refresh` | 60/min por IP |
  | `POST /auth/recovery/lookup` e `POST /auth/recovery/complete` (públicas) | 10/min por IP, **um orçamento só para as duas** (`THROTTLE_GROUPS.accountRecovery`) **e** 5/min por e-mail normalizado, por rota |
  | `PUT /me/password`, `PUT /me/recovery-code`, `PUT /organizations/:id/recovery-key`, `POST /spaces/:id/recover`, `POST /spaces/:id/recover/copies`, `POST /spaces/:spaceId/backup/trash/empty`, `POST /spaces/:spaceId/conversations/:id/trash/empty`, `PUT|DELETE /platform/staff/:userId/roles/:roleKey`, `POST /platform/support-requests` e `.../:id/approve|reject` (reautenticação) | 5 por 15 min por usuário, **um orçamento só para todas** |
  | `POST /invitations/preview` (pública) | 30/min por IP |
  | `POST /invitations/accept` | 10/min por IP |
  | `POST /spaces/:id/keys` (troca da chave do espaço) | 10/h por usuário (`userIdTracker`, contador próprio) |
  | `POST /hub-enrollments` (pública) | 20/h por IP |
  | `GET /hub-enrollments/:id/status` (pública) | 120/h por IP |
  | `POST /hub-auth/challenge` e `POST /hub-auth/token` (públicas) | 60/h por IP, **um orçamento só para as duas** (`THROTTLE_GROUPS.hubAuth`) |
  | `POST /hubs/claim` | 30/h por IP **e** 10/h por usuário (`@ThrottleByUser`) |
  | `POST /hubs/link-requests` | 10/h por usuário |
  | `POST /hub/link-codes` | 30/h por Hub (`hubIdTracker`) |
  | `GET /hub/sync` | 120/h por Hub (`hubIdTracker`) |
  | `POST /hub/user-sessions` (login de pessoa pelo Hub) | 10/min por Hub (`hubIdTracker`) **e** 5/min por e-mail normalizado (contador **próprio** da rota, separado do `/auth/login`) |
  | `POST /hub/spaces/:spaceId/uploads` e `POST /spaces/:spaceId/backup/uploads` (intenção de envio do backup) | 600/h por Hub (`hubIdTracker`) / por usuário (`userIdTracker`), contador próprio por rota |
  | `POST .../uploads/confirm` (confirmação do envio, as mesmas duas formas) | 600/h por Hub / por usuário |
  | `POST .../objects/delete` (apagar objetos do backup, as mesmas duas formas) | 120/h por Hub / por usuário |
  | `GET /hub/spaces/:spaceId/objects` e `GET /spaces/:spaceId/backup/objects` (listar o índice do backup) | 1200/h por Hub (`hubIdTracker`) / por usuário (`userIdTracker`), contador próprio por rota (restaurar: ~50 páginas de 1000 para 50 mil objetos) |
  | `POST .../objects/:objectId/versions/:versionId/download` (URL de download, as mesmas duas formas) | 12 mil/h por Hub / por usuário (uma URL por versão: 50 mil objetos em ~4 h) |
  | `POST /spaces/:spaceId/conversations` e `POST /hub/conversations` (criar assunto) | 120/h por usuário (`userIdTracker`) / por Hub (`hubIdTracker`), contador próprio por rota |
  | `POST .../conversations/:id/keys` (troca da chave do assunto, as duas formas) | 30/h por usuário / por Hub |
  | compartilhar, sair, tirar, estado, executor e mover o assunto (`/spaces/:spaceId/conversations/:id/...`, `PUT /hub/conversations/:id/state`) | 600/h por usuário / por Hub, contador próprio por rota |
  | mandar e apagar mensagem do assunto (`POST .../:id/messages`, `DELETE .../:id/messages/:messageId`) | 60/min por usuário / 300/min por Hub, contador próprio por rota |
  | `POST /hub/conversations/:id/messages/:messageId/ack` | 600/min por Hub |
  | anexo do assunto: intenção, confirmação e apagar (`POST .../:id/attachments`, `POST .../:id/attachments/:attachmentId/confirm`, `DELETE .../:id/attachments/:attachmentId`; a URL de download fica no limite geral) | 120/h por usuário / 600/h por Hub, contador próprio por rota |
  | `GET /conversations/changes` (feed da pessoa) / `GET /hub/conversations/changes` (feed do executor, sondagem longa) | 1200/h por usuário / 1800/h por Hub (ociosa: ~144/h, um pedido a cada 25 s; cada mudança acorda e devolve) |
  Rota com `@Throttle` próprio tem contador próprio (por rota); `@ThrottleGroup(THROTTLE_GROUPS.x, tracker?)`
  (`throttling.decorators.ts`) faz rotas dividirem um contador (chave = grupo + tracker, sem a rota); cada grupo é
  UMA constante com nome e limite em `THROTTLE_GROUPS` (`rate-limits.ts`), e o decorator recusa o mesmo grupo com
  limites diferentes. `@ThrottleByUser(limite)` soma um contador **por usuário e rota** (throttler nomeado `user`,
  `USER_THROTTLER`) ao `default` da rota, que fica livre para outro contador (ex.: reivindicação, por IP no `default` e
  por usuário no `user`, como o login faz com IP + e-mail). O tracker padrão (da biblioteca) já agrupa IPv6 no /64, como o `ipTracker` (fixado em
  `app-throttler.guard.spec.ts`). Limite por Hub usa
  `hubIdTracker` (`src/shared/infra/http/hub-id.tracker.ts`, lê `request.hub`): o `HubTokenGuard` precisa rodar antes do
  throttler (`HubsModule` antes do `ThrottlingModule`; fixado por `test/hubs/rate-limit.e2e-spec.ts`). Os contadores por e-mail não vão em cabeçalho.
  **Reautenticação:** toda rota que confere a prova da senha atual (`currentAuthProof`) leva `@ThrottleReauth()`
  (`throttling.decorators.ts`): throttler nomeado `reauth` (`REAUTH_THROTTLER`, `RATE_LIMITS.reauth`), chaveado só
  pelo usuário (`userIdTracker`, sem a rota — veja `AppThrottlerGuard.generateKey`), então as tentativas nas duas
  rotas somam no mesmo contador. Rota nova que verifica a senha atual entra nele.
- Estourou: **429 `problem+json`** (`type` `.../too-many-requests`) com `Retry-After` em segundos.
- Tabela `rate_limit_hits` (UNLOGGED) é **exceção documentada** às regras de timestamps/lápides/sem `DELETE`:
  contador técnico, sem `created_at`/`updated_at`/`deleted_at`, fora do TypeORM (sem entidade), e só nela o
  `app_runtime` tem `DELETE` (limpeza das linhas expiradas).
- `RATE_LIMIT_ENABLED` é lido a cada requisição; os e2e rodam com `false` (`vitest.config.e2e`) e
  `test/shared/rate-limit.e2e-spec.ts` liga com `createTestApp({ env: { RATE_LIMIT_ENABLED: 'true' } })`.
- **Limites residuais:** janela fixa (até 2x o limite numa virada de janela); a ordem dos guards importa (token
  antes do throttler; pinada por e2e); **falha fechada**: com o Postgres fora do ar o rate limit responde erro —
  health checks futuros devem usar `@SkipThrottle()`; o limite de 5/min por e-mail permite a um atacante
  bloquear o login de uma vítima por uma janela (trade-off aceito).

## TRUST_PROXY (obrigatório atrás de proxy)
- **Atrás de load balancer/proxy reverso, `TRUST_PROXY` é obrigatório**: o nº de saltos (`1`, `2`...) ou os CIDRs
  do proxy.
- `false` atrás de um LB faz **todos os clientes compartilharem um IP** (o do proxy): os limites por IP viram
  globais (login: 10/min para todo mundo) e o `lastIp` das sessões fica inútil.
- `true` ou `0.0.0.0/0` confiam em um `X-Forwarded-For` que o cliente controla: burlam os limites por IP e
  falsificam o `lastIp`. **Nunca em produção.**
- No boot, a API loga um WARN quando `NODE_ENV=production` com rate limit ligado e `TRUST_PROXY=false`, e quando
  `TRUST_PROXY` é `true` ou um CIDR que casa tudo (`trustProxyWarnings`).

## Argon2id em worker threads
- O Argon2id roda num pool de `worker_threads` (`ARGON2_POOL_SIZE`), fora do event loop. O arquivo do worker só
  pode usar TypeScript **apagável** (sem enums, namespaces ou parameter properties), pois é carregado sem o
  passo de transformação do Nest. A fila é limitada (`ARGON2_MAX_QUEUE`, padrão `threads × 64`, ~1,6 s de
  atraso): cheia, a requisição recebe 503 (`service-unavailable`) em vez de a fila crescer sem limite. Essa recusa
  é uma `LoadSheddingException` (`shared/infra/http`): o filtro só loga em `warn` e **não** manda ao Sentry, para
  um ataque não virar uma enxurrada de eventos. Use a mesma exceção para qualquer recusa por carga.
- O `main.ts` chama `app.enableShutdownHooks()`: no SIGTERM o HTTP para de aceitar e só depois os
  `onApplicationShutdown` rodam (o pool é destruído sem matar logins em andamento). Cada hash ativo ocupa
  ~19 MiB: dimensione o pool pela memória do container.

## Rotação de segredos
- **Semente do JWT (`AUTH_JWT_SIGNING_SEED`)**: rotação em **3 fases**, necessária com mais de uma instância
  (senão uma instância já assina com a chave nova que as outras ainda não conhecem):
  1. adicionar o `kid:seed` **novo** a `AUTH_JWT_PREVIOUS_KEYS` em todas as instâncias (só verifica) e fazer o deploy;
  2. trocar a assinatura para a semente/`AUTH_JWT_KEY_ID` novos e mover o `kid:seed` **antigo** para
     `AUTH_JWT_PREVIOUS_KEYS` (tirando o novo de lá); deploy. O validador recusa um `kid` anterior igual ao
     `AUTH_JWT_KEY_ID`, por isso cada fase é consistente;
  3. depois de **pelo menos o TTL do access token** (`AUTH_ACCESS_TOKEN_TTL_SECONDS`), remover a chave antiga.
- **`IDENTITY_DECOY_SALT_KEY`**: trocar muda o salt falso de **todos** os e-mails inexistentes, e um atacante que
  observou o salt antigo percebe a diferença (limite aceito). Rotacionar raramente.
- **`IDENTITY_RECOVERY_HASH_KEY`**: trocar invalida o código de recuperação de **todos** os usuários (o hash guardado
  deixa de conferir). Não trocar sem um plano de recadastro dos códigos (`PUT /me/recovery-code` de cada usuário).
- **Senha do login de runtime do banco**: o `02-app-role.sh` lê `DB_APP_PASSWORD` do ambiente do container `db`,
  fixado na criação dele — editar só o `.env` reaplicaria a senha **antiga**, sem avisar. Procedimento:
  1. atualizar `DB_APP_PASSWORD` no `.env`;
  2. `docker compose up -d db` (recria o container com o ambiente novo; os dados persistem);
  3. `docker exec vaulter-back-db sh /docker-entrypoint-initdb.d/02-app-role.sh` (executa `ALTER ROLE ... PASSWORD`);
  4. reiniciar a API.
  Alternativa sem recriar o container: `docker exec -e DB_APP_PASSWORD=... vaulter-back-db sh /docker-entrypoint-initdb.d/02-app-role.sh`
  (e atualizar o `.env` do mesmo jeito). **Atenção:** entre o `ALTER ROLE` e o restart da API, conexões novas do
  pool falham. Em produção (banco gerenciado), usar duas fases (dois logins/ papel alternado, ou janela curta
  de indisponibilidade combinada).

## Observabilidade
- **Sentry** para erros e tracing — o mesmo nos três softwares (backend Nest, app Ionic, hub Python), para
  seguir um problema de ponta a ponta. Sem DSN no `.env` (desenvolvimento), fica desligado.
- **Logs estruturados com `nestjs-pino`** (JSON), sempre com o `requestId` — o mesmo da resposta
  `problem+json`. Destino dos logs fica para quando houver produção; até lá, a saída do container.
- **Métricas da frota** (hubs online, atraso de sincronização, caixa de entrada parada, comandos com hub offline)
  entram quando houver hubs de clientes (ex.: Prometheus/Grafana).
- **Sentry 11 não tem `sendDefaultPii`:** usamos `dataCollection` desligado + `beforeSend` que limpa os campos
  sensíveis. No pino, `formatters.log` limpa as chaves sensíveis em **qualquer profundidade** (EventEmitters,
  `req` e `res` são tratados como opacos). O `requestId` é o cabeçalho `X-Request-Id` (aceito se casar
  `^[A-Za-z0-9-]{1,64}$`; senão é gerado), o mesmo da resposta `problem+json`.
- **Privacidade primeiro — o Vaulter não pode ler o cérebro do cliente, e a observabilidade não pode ser o
  vazamento:**
  - `dataCollection` desligado (veja acima); **nunca** anexar corpo de requisição;
  - `beforeSend` remove campos sensíveis (`wrapped_key`, `encrypted_private_key`, `auth_hash`, `kdf_*`, tokens,
    cabeçalho `Authorization`) — vale para Sentry e para os logs (redaction do pino);
  - o hub nunca envia conteúdo de memória, transcrição ou imagem; só tipo e local do erro;
  - Sentry na **região dos EUA**, junto com o resto; a proteção é a limpeza acima, não a região. **GlitchTip**
    (compatível com o SDK do Sentry) se um dia precisar hospedar.

## O que o app precisa fazer
O app é prototipado **depois** que o backend estiver fechado. Todo pedido ao app que nascer aqui (aviso, fluxo, campo
novo a usar) entra em [`docs/app/pendencias-do-app.md`](docs/app/pendencias-do-app.md) na mesma entrega.

## Documentação da API (interna × externa)
Dois públicos, nunca misturados: o **time** e os **integradores** (apps como Orion e Salte). A externa não pode
expor nada interno (cifra, infraestrutura, conexão do hub, endpoints de app/hub).
- **Referência gerada do código** com `@nestjs/swagger`, em **dois documentos**:
  - **interno:** todos os endpoints; só em desenvolvimento/ambiente interno;
  - **público:** **só** os controllers marcados como públicos (`@ApiTags('public')`) — os endpoints `/v1` da API
    de integração. Endpoint sem a marca nunca aparece na externa; marcar é decisão consciente, revisada.
- **Guias para integradores** em Markdown em `docs/integrators/` (primeiros passos, autenticação com
  `private_key_jwt`, apps × instalações, permissões, hub online/offline, caixa de entrada, erros, limites,
  versões e changelog). Nascem **junto com o módulo de integração**, não antes; mudou o comportamento público,
  atualiza o guia no mesmo commit.
- **Interna de produto/arquitetura** continua no `valter-valt-ai` (specs e decisões); o que for técnico do
  backend fica em `docs/` deste repositório.

## Git
- **Todo o desenvolvimento acontece na `develop`** (branch padrão). Não criar branches de feature nem trocar
  de branch sem o Jonas pedir.
- `main` e `develop` são protegidas contra remoção e force push — nunca usar `push --force`.
- Commits pequenos, no formato Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`...).

## Arquivos de contexto
| Arquivo | Versionado | Para quê |
|---|---|---|
| `CLAUDE.md` | sim | Regras e contexto do projeto, iguais para todos |
| `CLAUDE.local.md` | **não** (`.gitignore`) | Referências da máquina de cada dev |
| `CLAUDE.local-example.md` | sim | Template do `.local` para novos devs |

**Mantenha estes arquivos vivos.** Ao final de uma tarefa que mudou algo descrito aqui (comandos, stack,
convenções, estrutura, fluxo de git), atualize o arquivo certo na mesma entrega:
- mudou para todo mundo → `CLAUDE.md`;
- mudou só na máquina do dev → `CLAUDE.local.md`;
- surgiu um **tipo novo** de referência local (ex.: uma nova variável, um serviço novo para subir) → adicione
  o campo, sem valores reais, também no `CLAUDE.local-example.md`.

Nunca coloque segredos, tokens ou caminhos pessoais no `CLAUDE.md` nem no `CLAUDE.local-example.md`.
