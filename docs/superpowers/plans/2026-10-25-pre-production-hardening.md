# Endurecimento antes de produção (grupo 1) — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar as pendências antes de produção do CLAUDE.md: `typ`/`aud` e rotação de chave no JWT, `trust proxy`,
Argon2id fora do event loop, rate limiting nas rotas de autenticação e política de rotação dos segredos.

**Architecture:** Tudo continua dentro das camadas existentes. O hash Argon2id (libsodium) passa a rodar num pool
de `worker_threads` (piscina), atrás do mesmo port `AuthProofHasher`. O rate limiting usa `@nestjs/throttler` com
storage no próprio Postgres (tabela UNLOGGED), para valer com várias instâncias sem serviço novo. A configuração
nova entra no `validateEnv`.

**Tech Stack:** NestJS 12, `@nestjs/throttler` 6, `piscina` 5, `jose` 6, `libsodium-wrappers-sumo`, PostgreSQL 18, Vitest.

**Spec:** `CLAUDE.md` (seção "Pendências antes de produção" e decisões transversais) e o plano anterior
`docs/superpowers/plans/2026-10-24-identity-module.md` (decisões de sessão e token).

## Decisões deste plano
1. **JWT:**
   - o cabeçalho leva `typ: 'at+jwt'` (RFC 9068) e o token leva `aud` vindo de `AUTH_JWT_AUDIENCE` (obrigatória);
   - o `verify` exige os dois;
   - a rotação de chave usa `kid`: `AUTH_JWT_SIGNING_SEED` + `AUTH_JWT_KEY_ID` assinam, e `AUTH_JWT_PREVIOUS_KEYS`
     (opcional, `kid:seed[,kid:seed...]`) só verifica;
   - o `verify` escolhe a chave pelo `kid` do cabeçalho, e um `kid` desconhecido dá `invalid-access-token`.
2. **`trust proxy`:** a variável `TRUST_PROXY` aceita `false` (padrão), `true`, um número de saltos ou uma lista de
   IPs/CIDRs separados por vírgula. O `configureApp` aplica com `app.set('trust proxy', ...)`, e daí saem `req.ip`
   (o `lastIp` das sessões) e a chave do rate limit.
3. **Argon2id fora do event loop:**
   - `SodiumAuthProofHasher` delega `hash`/`verify` a um pool piscina, com worker em
     `src/identity/infra/crypto/argon2.worker.ts`;
   - o worker é autocontido, importando só `libsodium-wrappers-sumo`, e roda os mesmos parâmetros
     (ops 2, mem 19922944);
   - o tamanho do pool vem de `ARGON2_POOL_SIZE` (padrão `min(4, os.availableParallelism())`);
   - o arquivo do worker resolve para `.js` no build e para `.ts` nos testes (Node 24 remove tipos nativamente, por
     isso o worker não pode usar sintaxe TS não apagável);
   - `verifyAgainstDummy` continua com o mesmo custo;
   - o pool é destruído no `onModuleDestroy`.
4. **Rate limiting** com `@nestjs/throttler`, guard global e storage Postgres:
   - **tabela:** `rate_limit_hits` UNLOGGED, com a migration concedendo `DELETE` a `app_runtime` só nela. É exceção
     documentada à regra de timestamps e lápides, porque é contador técnico, não dado de cliente nem sincronizável;
   - **gravação:** o incremento é um upsert atômico, e as linhas expiradas são limpas oportunisticamente;
   - **chaves:** IP por padrão, e-mail normalizado no login, userId em `/me/password`;
   - **limites** (constantes em `src/shared/infra/http/rate-limits.ts`):

     | Rota | Limite |
     |---|---|
     | padrão global | 300/min por IP |
     | `POST /auth/prelogin` | 30/min por IP |
     | `POST /auth/register` | 10/h por IP |
     | `POST /auth/login` | 10/min por IP **e** 5/min por e-mail |
     | `POST /auth/refresh` | 60/min por IP |
     | `PUT /me/password` | 5 a cada 15 min por usuário |

   - **resposta:** estourou, responde 429 em `problem+json` (`type …/too-many-requests`) com `Retry-After`;
   - **liga e desliga:** `RATE_LIMIT_ENABLED` (padrão `true`), desligado no e2e geral. Um e2e próprio liga o rate
     limit para testar.
5. **Rotação de segredos:**
   - **`02-app-role.sh`:** passa a fazer `ALTER ROLE ... PASSWORD` quando o login já existe, então rodar de novo
     troca a senha;
   - **CLAUDE.md:** documenta o procedimento de cada segredo:
     - seed JWT: rotação por `kid` sem derrubar sessões;
     - chave do salt falso: trocar muda todos os salts falsos, então rotacionar raramente, limite aceito;
     - senha do papel de runtime.

## Global Constraints
- ESM com `.js` nos imports relativos; Vitest; oxlint; Prettier. Os e2e rodam no container:
  `docker exec vaulter-back-app npx vitest run --config vitest.config.e2e.ts <arquivo>`.
- O domínio continua puro. Os adapters ficam em `infra/` e os casos de uso não mudam de assinatura.
- O nome do produto nunca entra em código. `aud` e `iss` vêm do `.env`.
- Erros em `problem+json` com `requestId`. Nenhuma entrada vira 500.
- Nunca logar segredos (seeds, chaves, tokens).
- Commits pequenos (Conventional Commits) direto na `develop`, com push a cada commit. Antes de dar por pronto:
  `npm run build && npm test && npm run lint`, `npm run test:e2e` no container e CI verde.

## Review Focus
1. **Token assinado com a chave anterior durante a rotação:** é aceito enquanto o `kid` estiver em
   `AUTH_JWT_PREVIOUS_KEYS` e passa a ser recusado quando ele sai. (Task 1)
2. **`X-Forwarded-For` forjado com `TRUST_PROXY=false`:** é ignorado e o `lastIp` fica com o IP real da conexão.
   (Task 2)
3. **Logins concorrentes não travam outras rotas:** durante verificações Argon2 em paralelo, um `setInterval` de
   10 ms não atrasa mais de 50 ms. (Task 3)
4. **Credential stuffing distribuído:** muitos IPs atacando o mesmo e-mail são barrados pelo limite por e-mail, e o
   429 do login tem o mesmo formato para e-mail existente e inexistente. (Task 4)
5. **Duas instâncias da app:** dividem o mesmo contador, porque o storage fica no Postgres. (Task 4)

---

### Task 1: JWT com `typ`, `aud` e rotação por `kid`
**Files:** `src/identity/infra/crypto/jose-access-token-service.ts` (+ spec), `src/shared/infra/config/env.validation.ts`
(+ spec), `.env.example`, `.env` (só acrescentar), `.github/workflows/ci.yml`, `vitest.config.e2e.ts` se precisar.
**Interfaces:** o port `AccessTokenService` não muda. Entram as variáveis novas `AUTH_JWT_AUDIENCE` (string não vazia,
obrigatória) e `AUTH_JWT_PREVIOUS_KEYS` (opcional, cada item `kid:seed` com seed base64url de 32 bytes, validado).
- [ ] Testes falhando:
  - o token emitido tem `typ: 'at+jwt'` no cabeçalho e `aud` igual a `AUTH_JWT_AUDIENCE`;
  - token sem `typ` ou com outro `typ`, assinado com a chave certa, dá `invalid-access-token`;
  - token com `aud` diferente dá `invalid-access-token`;
  - token assinado pela chave anterior (`kid` antigo em `AUTH_JWT_PREVIOUS_KEYS`) é aceito;
  - o mesmo token, sem o `kid` na lista, é recusado;
  - `kid` desconhecido é recusado;
  - `AUTH_JWT_PREVIOUS_KEYS` malformada falha no `validateEnv`.
- [ ] Implementar. As chaves são derivadas no `onModuleInit` (mapa `kid → chave pública`) e o `jwtVerify` recebe
  uma função de chave por `kid`, com `algorithms: ['EdDSA']`, `issuer`, `audience`, `typ: 'at+jwt'` e
  `currentDate`.
- [ ] Verificar (build, test, lint, e2e) e commitar `feat(identity): typed access tokens with audience and key rotation`.

### Task 2: `trust proxy`
**Files:** `src/shared/infra/http/configure-app.ts`, `src/shared/infra/config/env.validation.ts` (+ spec), `.env.example`,
`test/identity/sessions.e2e-spec.ts` ou um e2e novo `test/shared/trust-proxy.e2e-spec.ts`.
**Interfaces:** `parseTrustProxy(raw: string | undefined): boolean | number | string[]`, puro e testado.
- [ ] Testes:
  - `parseTrustProxy('false')` → `false`, `'true'` → `true`, `'1'` → `1`, `'10.0.0.0/8, 127.0.0.1'` → lista;
  - valores inválidos falham no `validateEnv`;
  - e2e com `TRUST_PROXY=false`: login com `X-Forwarded-For: 203.0.113.9` deixa o `lastIp` da sessão diferente de
    `203.0.113.9`;
  - e2e com a app configurada com `TRUST_PROXY=1` (app própria no teste, sobrescrevendo o `ConfigService`):
    `lastIp === '203.0.113.9'`.
- [ ] Implementar e commitar `feat(shared): configurable trust proxy`.

### Task 3: Argon2id num pool de workers
**Files:** `src/identity/infra/crypto/argon2.worker.ts` (novo), `src/identity/infra/crypto/sodium-auth-proof-hasher.ts`
(+ spec), `src/shared/infra/config/env.validation.ts`, `package.json` (piscina), `.env.example`.
**Interfaces:** o port `AuthProofHasher` não muda. O worker exporta `default async function ({ op, authProof, authHash })`,
com `op` em `'hash' | 'verify'`, e devolve string ou boolean.
- [ ] Testes falhando:
  - os testes atuais do hasher continuam passando: round-trip, prova errada, prefixo `$argon2id$`, dummy devolve
    `false` e hash malformado devolve `false` sem lançar;
  - **event loop livre:** com 8 `verify` em paralelo e um `setInterval` de 10 ms, o maior atraso medido fica abaixo
    de 50 ms;
  - um hash gerado pela versão anterior (síncrona) verifica no worker, porque o formato não mudou;
  - o pool é destruído no `onModuleDestroy` (o teste não fica pendurado).
- [ ] Implementar. Resolver o arquivo do worker com
  `new URL('./argon2.worker.js', import.meta.url)`, caindo para `.ts` quando o `.js` não existir. Conferir no build
  (`dist/`) que o worker é emitido e que a API sobe e faz login no container.
- [ ] Commitar `perf(identity): run Argon2id in a worker pool`.

### Task 4: Rate limiting com storage no Postgres
**Files:**
- `src/shared/infra/http/rate-limits.ts`;
- `src/shared/infra/http/postgres-throttler.storage.ts` (+ teste de integração);
- `src/shared/infra/http/throttling.module.ts` (ou o equivalente em `app.module.ts`);
- uma migration `CreateRateLimitHits` (manual), com a entidade TypeORM correspondente para que o
  `migration:generate` saia vazio, ou registrada como exceção explícita, conforme o que for mais limpo;
- os decorators `@Throttle`/`@SkipThrottle` nos controllers do identity;
- o filtro de erros, se precisar ajustar o 429 e o `Retry-After`;
- `env.validation.ts`, `.env.example` e `vitest.config.e2e.ts` (`RATE_LIMIT_ENABLED=false`);
- `test/shared/rate-limit.e2e-spec.ts`.

**Interfaces:** `PostgresThrottlerStorage implements ThrottlerStorage`, com
`increment(key, ttl, limit, blockDuration, throttlerName)`. Um tracker por e-mail no login lê o `email` do corpo,
normalizado com `normalizeEmail`.
- [ ] Testes falhando:
  - storage (integração): incrementos concorrentes contam certo; o bloqueio expira depois de `blockDuration`; duas
    instâncias do storage (dois `DataSource`) dividem o contador;
  - e2e com rate limit ligado:
    - o 11º login do mesmo IP no mesmo minuto dá 429 `problem+json` com `type …/too-many-requests` e `Retry-After`;
    - o 6º login do mesmo e-mail vindo de IPs diferentes (`TRUST_PROXY=1` + `X-Forwarded-For`) dá 429;
    - o 429 é idêntico para e-mail existente e inexistente;
    - o refresh tem limite próprio;
    - `PUT /me/password` dá 429 na 6ª tentativa em 15 min;
    - rotas sem limite específico seguem o padrão global.
- [ ] Implementar e commitar `feat(shared): Postgres-backed rate limiting on auth routes`.

### Task 5: Rotação de segredos e documentação
**Files:** `.docker/postgres/init/02-app-role.sh`, `CLAUDE.md`, `.env.example` e `docs/crypto/user-keys.md`, se citar
`aud` ou `typ`.
- [ ] O `02-app-role.sh` faz `ALTER ROLE ... PASSWORD` quando o login existe. Rodar duas vezes com senhas
  diferentes no banco de dev e conferir o login com a nova (`psql` com a senha nova funciona e com a antiga
  falha), restaurando a senha original no fim.
- [ ] CLAUDE.md:
  - tirar das pendências o que foi feito;
  - documentar as variáveis novas;
  - documentar o procedimento de rotação de cada segredo;
  - documentar a exceção da tabela `rate_limit_hits`;
  - documentar os limites.
- [ ] Verificação completa e CI verde. Commitar `docs: secrets rotation and pre-production hardening`.
