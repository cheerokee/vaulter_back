# CLAUDE.md — Vaulter Back

Orientações para o Claude Code neste repositório. Vale para todo o time: só entra aqui o que é verdade para
qualquer dev. Referências da sua máquina (caminhos, portas, credenciais, repos irmãos) vão no
`CLAUDE.local.md` — veja a seção [Arquivos de contexto](#arquivos-de-contexto).

## Idioma
Responda sempre em português (pt-BR). Código, nomes de variáveis, logs e mensagens de commit seguem em inglês.

## O que é
API backend do Vaulter, em **NestJS 12** + **TypeScript 6** (modo `strict`), rodando em **Node >= 20**
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
npm run lint         # oxlint com checagem de tipos
npm run format       # Prettier em src/ e test/
```
Antes de dizer que algo está pronto: `npm run build && npm test && npm run lint` precisam passar
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
  | `aws` (LocalStack, só S3) | `vaulter-back-aws` | `http://aws:4566` | `localhost:${AWS_EXTERNAL_PORT}` |
- **Banco único:** o Postgres guarda tanto os dados relacionais quanto os embeddings de RAG (extensão
  **pgvector**, já habilitada na criação do banco por `.docker/postgres/init/01-extensions.sql`). Não criar
  outro banco para vetores sem uma razão forte.
- Credenciais e portas vêm do `.env` (`DB_*`, `PGADMIN_PORT`); os valores padrão estão no `.env.example`.
- O pgAdmin roda em modo desktop (sem login) e já abre com o servidor `vaulter-back` cadastrado
  (`.docker/pgadmin/servers.json`); só pede a senha do banco (`DB_PASSWORD`) na primeira conexão.
- **Papel de runtime:** a API conecta como `DB_APP_USERNAME` (padrão `vaulter_app`; `NOSUPERUSER NOBYPASSRLS`,
  membro de `app_runtime`, com `SELECT/INSERT/UPDATE` e **sem `DELETE`**), para o RLS valer de verdade. Migrations,
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
  (`S3_FORCE_PATH_STYLE=true`). Layout do bucket: `orgs/<orgId>/spaces/<spaceId>/...`.
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
  - trade-off conhecido: quem souber o id de uma sessão pode forçar a revogação dela apresentando um refresh
    token forjado (não ganha acesso nenhum); os clientes devem **serializar** as chamadas de refresh.
  - Formato v1 das chaves do usuário (Argon2id, normalização NFC da senha, vetor de teste):
    [`docs/crypto/user-keys.md`](docs/crypto/user-keys.md).
- **Tarefas em segundo plano:** **pg-boss** (fila no próprio Postgres, sem serviço novo).
- **AWS:** região **`us-east-1` (Virgínia)** — o backend fica perto dos serviços externos (Anthropic, OpenRouter,
  Sentry), então só a ida app → backend cruza o continente; mais barata e com todos os serviços. LGPD permite
  transferência internacional com salvaguardas (o backup é cifrado e ilegível para nós). Região é
  configuração: se um cliente exigir dados no Brasil, a organização dele pode ir para um bucket em `sa-east-1`.
- **CI:** GitHub Actions (`.github/workflows/ci.yml`) em todo push na `develop`/`main` e em PR: `build`, `lint`,
  `test` e `test:e2e` (com PostgreSQL 18 + pgvector como serviço). Manter verde; se quebrar, consertar antes de seguir.

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
  `requestId` (e, em validação, a lista de campos inválidos). Erros 4xx do body-parser (413 corpo grande,
  400 JSON malformado) também saem como problem+json. Stack trace, SQL e mensagem crua do banco vão só
  para o log, nunca para a resposta.
- O modelo de dados e as regras de negócio vêm da spec
  `valter-valt-ai/docs/superpowers/specs/2026-10-24-organizacoes-espacos-e-nuvem-design.md` e do DER em
  `docs/der_model.sql`.

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
   constraints nos metadados), mapper domínio ↔ entidade e repositório que implementa o contrato.
4. Migration em `src/database/migrations/` (`addSyncVersionTrigger` / `enableOrganizationRls` quando couber;
   dado de cliente tem `organization_id` e RLS); `migration:generate` depois dela deve sair vazio.
5. `infra/http/`: controllers e DTOs de borda. Rotas exigem token por padrão (guard global); abra uma rota com
   `@Public()` e leia o chamador com `@CurrentAuth()` (ambos em `src/shared/infra/http/auth.decorators.ts`).
6. `<modulo>.module.ts`: `TypeOrmModule.forFeature([...])` e `{ provide: Contrato, useClass: Implementacao }`.
7. Testes: unitários com contratos simulados via `vi`, ao lado do código; e2e em `test/<modulo>/`, reaproveitando
   `test/support/`.

## Banco de dados (TypeORM + migrations)
- **TypeORM 1.x** + `@nestjs/typeorm`, driver `pg`. Config de conexão em `src/database/typeorm.options.ts`,
  compartilhada entre a aplicação (`DatabaseModule`) e o CLI (`src/database/data-source.ts`). Variáveis do
  `.env` (`DB_*`) são carregadas pelo `ConfigModule` (app) e por `process.loadEnvFile` (CLI).
- **Toda tabela tem `created_at`, `updated_at` e `deleted_at`**, vindos de uma entidade base (`@CreateDateColumn`,
  `@UpdateDateColumn`, `@DeleteDateColumn`). **Offline-first:** o que o hub/app sincronizam nunca sofre
  `DELETE` físico — excluir é `softDelete()` (lápide); tabela de ligação que volta a existir tem o
  `deleted_at` limpo, não uma linha nova. Essas tabelas têm também `sync_version` (sequência global do
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
  de uma migration, `migration:generate` precisa sair vazio.

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
| `AUTH_JWT_KEY_ID` | `kid` do cabeçalho do JWT | obrigatória |
| `AUTH_JWT_SIGNING_SEED` | semente Ed25519 (32 bytes em base64url) — **segredo** | obrigatória |
| `AUTH_ACCESS_TOKEN_TTL_SECONDS` | validade do access token | `900` |
| `AUTH_REFRESH_TOKEN_IDLE_DAYS` | inatividade máxima do refresh | `30` |
| `IDENTITY_DECOY_SALT_KEY` | chave do salt falso do pré-login (32 bytes em base64url) — **segredo** | obrigatória |

Os valores do `.env.example` para os segredos são **só de desenvolvimento**; produção gera os próprios:
`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.

## Pendências antes de produção
- Rate limiting no login, refresh e troca de senha (`@nestjs/throttler`; o Argon2 roda no event loop).
- Argon2id fora do event loop (pool de `worker_threads` ou binding nativo assíncrono): cada verificação leva
  ~24 ms e bloqueia o loop.
- `trust proxy` configurado para `req.ip`/`lastIp` corretos atrás de load balancer.
- `typ: at+jwt` e `aud` nos tokens de acesso, antes de existir outro tipo de JWT ou validação offline no hub.
- Política de rotação de segredos: `AUTH_JWT_SIGNING_SEED` (via `kid`), `IDENTITY_DECOY_SALT_KEY` e a senha do
  role de runtime do banco (`02-app-role.sh` não troca a senha de um role já existente).
- JWKS público para o hub validar tokens offline.
- Exclusão de conta (LGPD) precisa revogar as sessões.

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
