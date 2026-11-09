# Storage e backup cifrado — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backup cifrado obrigatório dos espaços no S3 (envio direto por URL assinada, índice no backend, lixeira de 30 dias), tamanhos reservados por espaço, franquia por organização, capacidade do Hub, login de pessoas pelo Hub com sessão presa a ele.

**Architecture:** Módulo novo `src/storage/` (índice + fluxo de envio/baixa) sobre uma porta `ObjectStore` (adaptador S3 com `@aws-sdk/client-s3` + presigner; LocalStack em dev/CI). Tamanhos e franquia ficam nos módulos donos (`spaces`, `organizations`, `hubs`); `storage` depende deles só pelo que exportam. Uso do espaço calculado pelo índice, sem rotina de limpeza na v1 (versões fora da lixeira simplesmente deixam de contar; o S3 as expira sozinho).

**Tech Stack:** NestJS 12, TypeScript 6 (ESM), TypeORM 1.x + Postgres 18 (RLS), `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner`, LocalStack 4.14.0, libsodium (testes do Hub), Vitest + supertest.

**Spec:** `docs/superpowers/specs/2026-11-09-storage-backup-design.md` (autoridade).

## Global Constraints

- Docs pt-BR; código/logs/commits em inglês (Conventional Commits). Tudo na `develop`; push depois de cada commit.
- `storage` depende de `spaces`, `organizations`, `hubs`, `identity` só pelo que exportam da `application/`; ninguém importa `storage`. Nada de `infra/` alheia.
- Tabelas novas: `organization_id`, RLS por organização (`enableOrganizationRls`), timestamps/lápide, FKs compostas `(filho, organization_id) -> (pai.id, pai.organization_id)` para espaço; sem `DELETE` para o runtime.
- Índice nunca guarda nome, tipo ou caminho de arquivo: só ids, `keyVersion`, `sizeBytes`, `sha256` (hex 64 do blob cifrado), `s3VersionId`, quem enviou, datas.
- Caminhos no bucket: `orgs/<orgId>/spaces/<spaceId>/uploads/<uploadId>` (provisório, expira em 1 dia) e `orgs/<orgId>/spaces/<spaceId>/objects/<objectId>` (versões antigas e *delete markers* expiram em 30 dias). Bucket só pelo `.env` (`S3_BUCKET_HUB_BRAIN`).
- Valores: espaço padrão **10 GB** (`10_737_418_240`), franquia padrão da organização **50 GB** (`53_687_091_200`), objeto máximo **5 GB** (`5_368_709_120`), lixeira **30 dias**, URL assinada **15 min**.
- Permissões de conteúdo: enviar = `memory.write`; apagar = `memory.delete`; baixar/listar = `memory.read` (catálogo RBAC atual). Hub fora da Sala do espaço, ou sem a permissão: **404** `space-not-found` (sem revelar). Usuário: `SpaceAccess` (404 não membro, 403 sem permissão).
- Erros: `space-key-rotation-required` 409, `space-key-version-stale` 409, `object-version-conflict` 409, `space-storage-full` 422, `organization-storage-quota-exceeded` 422, `hub-storage-full` 422, `object-too-large` 422, `upload-not-found` 404, `upload-mismatch` 422 (tamanho/checksum do provisório diferente).
- Antes de cada commit: host `npm run build && npm test && npm run lint && npm run typecheck`; container `migration:run`, `schema:check`, `test:e2e` quando mexer em banco/HTTP/S3.

## Review Focus

1. **Envio confirmado com o objeto provisório diferente do declarado** (tamanho ou sha256): 422 `upload-mismatch`, nada entra no índice, a versão atual continua a mesma. → Task 6.
2. **Confirmação repetida da mesma intenção** (o Hub reenviou depois de um timeout): idempotente, uma versão só no índice. → Task 6.
3. **Espaço que passa a ter `keyRotationRequired` entre a intenção e a confirmação**: a confirmação também recusa (409) e nada entra. → Task 6.
4. **Hub tirado da Sala** (ou desvinculado) e ainda com URL de GET válida: a URL vence em 15 min; novas URLs e listagens dão 404. → Task 7.
5. **Sessão aberta pelo Hub depois que a pessoa perde o papel no Hub**: refresh e access dão 401. → Task 5.

---

### Task 1: Contrato do objeto cifrado

**Files:** Create `docs/crypto/space-backup.md`; Modify `test/support/hub-crypto.ts` (+ `test/support/client-crypto.spec.ts` ou spec próprio)

**Interfaces:**
- Produces (teste): `sealBackupObject(spaceKey: Uint8Array, ctx: { spaceId: string; objectId: string; keyVersion: number }, plaintext: Uint8Array, nonce?: Uint8Array): Promise<Uint8Array>` e `openBackupObject(spaceKey, ctx, blob): Promise<Uint8Array>`; formato `0x01 ‖ nonce(24) ‖ XChaCha20-Poly1305(plaintext, ad)` com `ad = 0x01 ‖ ASCII "space-object" ‖ spaceId(16 bytes) ‖ objectId(16 bytes) ‖ keyVersion (uint32 big-endian)`; `sha256Hex(blob)`.
- [ ] Step 1: testes que falham — vetor fixo (chave `0x00..0x1f`, nonce `0x20..0x37`, ids fixos, `keyVersion` 1, texto `"hello"`) bate com o `space-backup.md`; abrir com outro `objectId`, outro `spaceId` ou outra `keyVersion` lança.
- [ ] Step 2: rodar → FAIL. Step 3: implementar e escrever o doc (formato, AD, sha256 do blob, limite de 5 GB por objeto e divisão pelo Hub, manifesto cifrado como objeto comum, nada de nome em claro). Step 4: PASS. Step 5: commit `docs(crypto): space backup object format`.

### Task 2: Porta `ObjectStore`, adaptador S3 e infraestrutura

**Files:** Create `src/storage/application/ports/object-store.ts`, `src/storage/infra/s3/s3-object-store.ts`, `src/storage/storage.module.ts` (registrado no AppModule); Modify `src/shared/infra/config/env.validation.ts` (+ spec), `.env.example`, `.github/workflows/ci.yml` (serviço LocalStack `localstack/localstack:4.14.0`, bucket criado e versionado no job), `.docker/localstack/init/ready.d/01-buckets.sh` (regras de ciclo de vida), `package.json` (deps)
- Test: `test/storage/object-store.e2e-spec.ts` (contra o LocalStack)

**Interfaces:**
- Produces:
  ```ts
  abstract class ObjectStore {
    presignPut(key: string, input: { sizeBytes: number; sha256Hex: string; expiresInSeconds: number }): Promise<{ url: string; headers: Record<string, string> }>;
    presignGet(key: string, versionId: string, expiresInSeconds: number): Promise<string>;
    head(key: string): Promise<{ sizeBytes: number; sha256Hex: string | null; versionId: string | null } | null>;
    copy(fromKey: string, toKey: string): Promise<{ versionId: string }>;
    deleteCurrent(key: string): Promise<{ deleteMarkerVersionId: string }>;
  }
  ```
  A URL de PUT assina `Content-Length` e `x-amz-checksum-sha256` (base64 do sha256), para o S3 recusar bytes diferentes; `head` lê o checksum (`ChecksumMode: ENABLED`). `copy` preserva/recalcula o checksum sha256.
  - Env validada: `AWS_REGION`, `AWS_ENDPOINT_URL` (opcional), `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (opcionais: em produção vêm do papel IAM), `S3_FORCE_PATH_STYLE` (bool), `S3_BUCKET_HUB_BRAIN` (obrigatória).
  - Script do LocalStack: regra de ciclo de vida com `NoncurrentVersionExpiration 30 dias` + `ExpiredObjectDeleteMarker` no prefixo `orgs/` e expiração de 1 dia para objetos sob `*/uploads/` (usar filtro por tag `stage=upload` se o filtro por prefixo não alcançar o meio do caminho — documentar a escolha).
- [ ] Step 1: e2e que falha — PUT pela URL assinada com os bytes certos → 200 e `head` devolve tamanho/sha256; bytes diferentes → o S3 recusa; `copy` gera `versionId`; duas cópias para o mesmo destino geram versões diferentes; `presignGet` com o `versionId` antigo devolve os bytes antigos; `deleteCurrent` cria *delete marker* e a versão antiga continua baixável pelo `versionId`.
- [ ] Step 2: FAIL. Step 3: implementar; documentar no `.env.example`. Step 4: verificação completa (o compose e o CI com LocalStack). Step 5: commit `feat(storage): object store over S3`.

### Task 3: Tamanho do espaço, franquia da organização e capacidade do Hub

**Files:** Modify `spaces` (domínio `space.ts`, criação, DTO de criação, nova rota de tamanho), `organizations` (domínio/entidade, view), `hubs` (domínio/entidade, `add-hub-space.use-case.ts`, rota `PUT /hub/storage`, view de Hub); migration `1792895800000-StorageQuotas.ts`; DER
- Test: unit ao lado; `test/storage/quotas.e2e-spec.ts`

**Interfaces:**
- Produces:
  - Colunas: `spaces.storage_quota_bytes bigint NOT NULL DEFAULT 10737418240`; `organizations.storage_quota_bytes bigint NOT NULL DEFAULT 53687091200`; `hubs.storage_capacity_bytes bigint NULL` (GRANT de UPDATE por coluna em `hubs` estendido a ela). CHECKs `> 0`.
  - `POST` de criação de espaço aceita `storageQuotaBytes` opcional (1 GiB..5 TiB; padrão 10 GB); recusa se a soma dos reservados vivos da organização + novo > franquia (`organization-storage-quota-exceeded`, `details: { availableBytes }`), sob a trava da linha da organização (`FOR NO KEY UPDATE`, como já existe).
  - `PUT /spaces/:id/storage-quota` `{ storageQuotaBytes }` (Gestor, `space.members.manage`): aumentar confere franquia **e** a capacidade de cada Hub onde o espaço está instalado (`hub-storage-full` com `hubId` e `missingBytes`); diminuir abaixo do uso → 422 `space-storage-quota-below-usage` (o uso vem do `storage`: nesta task, uma porta `SpaceStorageUsage.usedBytes(spaceId)` exportada pelo `spaces` com implementação provisória devolvendo 0, trocada na Task 6 — o `storage` registra a implementação real).
  - Exportado pelo `organizations`: `OrganizationDirectory.storageQuota(orgId): Promise<{ quotaBytes: number; reservedBytes: number } | null>` e a trava de linha usada acima.
  - `PUT /hub/storage` (token de Hub) `{ capacityBytes }` (1 GiB..64 TiB): grava; menor que o reservado é aceito.
  - `AddHubSpaceUseCase`: com capacidade conhecida, soma dos `storage_quota_bytes` dos espaços instalados neste Hub (todas as organizações, lendo no contexto de cada uma) + o novo ≤ capacidade, senão 422 `hub-storage-full` (`details: { missingBytes }`); capacidade nula → sem conferência.
  - Views: `GET /spaces/:id` ganha `storage: { quotaBytes, usedBytes }`; `GET /organizations/:id` ganha `storage: { quotaBytes, reservedBytes }`; `GET /hubs/:id` ganha `storage: { capacityBytes, reservedBytes }` (reservado = espaços instalados que quem consulta vê; o dono vê todos).
- [ ] Step 1: testes que falham (unit nas regras; e2e: criar acima da franquia → 422 com `availableBytes`; aumentar além de um Hub → 422 `hub-storage-full`; instalar sem caber → 422; Hub sem capacidade → instala; Hub informa capacidade menor que o reservado → 204 e próxima instalação 422; views com os números).
- [ ] Step 2: FAIL. Step 3: implementar. Step 4: verificação completa. Step 5: commit `feat(storage): space sizes, organization quota and hub capacity`.

### Task 4: Franquia ajustada pelo financeiro

**Files:** `src/platform/domain/platform-catalog.ts`, migration `1792895900000-PlatformStorageQuotaPermission.ts` (nova permissão `platform.billing.storage_quota` para `platform_finance` e `platform_admin`), `organizations` (`OrganizationAdministration.setStorageQuota(orgId, quotaBytes, actor, now)`), `src/platform/application/set-organization-storage-quota.use-case.ts`, controller
- Test: `test/platform/storage-quota.e2e-spec.ts`; e2e do catálogo atualizado

**Interfaces:**
- `PUT /platform/organizations/:orgId/storage-quota` `{ quotaBytes, reason, currentAuthProof }` (`@RequirePlatformPermission('platform.billing.storage_quota')`, `@ThrottleReauth()`); `quotaBytes` < reservado → 422 `storage-quota-below-reserved`; organização inexistente → 404. Auditoria: `platform.organization.storage_quota_changed` na trilha da plataforma (com `from`, `to`, `reason`) e `organization.storage_quota_changed` no `audit_logs` da organização (`user_id` nulo, `{ actor: 'platform' }`; sem `supportRequestId`, que não existe aqui — o `AuditActor` ganha a forma `{ kind: 'platform'; staffAction: string }` ou equivalente, documentada).
- [ ] Steps: testes (financeiro ajusta → 200 e `GET /organizations/:id` mostra; suporte → 404; abaixo do reservado → 422; auditorias), FAIL, implementar, verificação, commit `feat(platform): finance adjusts organization storage quota`.

### Task 5: Login de pessoas pelo Hub, com sessão presa a ele

**Files:** `identity` (sessão ganha `hub_id`; `LoginUseCase` recusa `device.platform = 'hub'` com o mesmo `invalid-credentials`; método exportado para o `hubs` iniciar sessão presa ao Hub; `revokeAllForUserOnHub(userId, hubId, reason)` e `revokeAllOnHub(hubId, reason)`; motivo novo `hub_access_lost` no CHECK), `hubs` (`POST /hub/user-sessions` com token de Hub: `{ email, authProof, device }` → recusa quem não tem papel no Hub com o mesmo `invalid-credentials` e o mesmo tempo; chama o `identity`; revogações em: retirar papel explícito, desvincular organização (pessoas que ficam sem papel), saída da organização, desregistro), migration `1792896000000-HubBoundSessions.ts`
- Test: `test/hubs/user-sessions.e2e-spec.ts`; ajustar `test/support/hub-client.ts` (`loginPerson`)

**Interfaces:**
- `user_sessions.hub_id uuid NULL` (FK para `hubs`; sessão de Hub tem `device_platform = 'hub'` e `hub_id` não nulo, CHECK).
- Exportado pelo `identity`: `HubSessionIssuer.loginOnHub({ hubId, email, authProof, device, client, isAllowed: (userId) => Promise<boolean> }): Promise<LoginResult>` — a checagem de papel vem do `hubs` (o `identity` não importa `hubs`); falha de senha ou de papel = mesmo erro.
- [ ] Steps: testes (membro de organização vinculada loga pelo Hub → 200; não membro com senha certa → 401 `invalid-credentials`; `/auth/login` com `platform: 'hub'` → 401; retirar papel / desvincular / desregistrar → refresh da sessão do Hub 401 (Review Focus 5); sessões do celular da mesma pessoa não caem), FAIL, implementar, verificação, atualizar `hub-lifecycle.md` §10 no mesmo commit, commit `feat(hubs): person login through the hub with hub-bound sessions`.

### Task 6: Índice e envio (intenção, confirmação, apagar)

**Files:** `src/storage/domain/` (`backup-object.ts`, `backup-object-version.ts`, repositórios), `src/storage/application/` (`request-uploads.use-case.ts`, `confirm-uploads.use-case.ts`, `delete-objects.use-case.ts`, `storage-access.ts`, `space-storage-usage.ts` implementação real), `src/storage/infra/db/`, `infra/http/` (rotas com token de Hub e com token de usuário), migration `1792896100000-CreateStorageIndex.ts`; `spaces` exporta o que o `storage` precisa (`SpaceAccess` para usuário; para Hub, `SpaceRoomService.roomPermissionsOf(spaceId, hubId)` ou equivalente; `keyRotationRequired` e `currentKeyVersion` do espaço)
- Test: unit ao lado; `test/storage/uploads.e2e-spec.ts` (Hub real pelo `hub-client`, LocalStack real)

**Interfaces:**
- Tabelas: `storage_objects` (`id` = `objectId` do Hub, `organization_id`, `space_id`, `current_version_id` nulo, `deleted_at`), `storage_object_versions` (`id` uuid v7 do servidor = `uploadId`, `organization_id`, `space_id`, `object_id`, `key_version`, `size_bytes` bigint, `sha256` char(64), `status` `pending|committed|expired`, `replaces_version_id` nulo, `s3_version_id` nulo, `uploaded_by_hub_id`/`uploaded_by_user_id` (um dos dois), `upload_expires_at`, `superseded_at` nulo, timestamps). RLS por organização, FKs compostas.
- Uso do espaço = soma de `size_bytes` das versões `committed` com `superseded_at IS NULL OR superseded_at > now() - 30 dias`, mais as `pending` não vencidas (reserva).
- Rotas (Hub: `/hub/spaces/:spaceId/...` com token de Hub; pessoa logada pelo Hub: `/spaces/:spaceId/backup/...` com token de usuário — mesmo caso de uso, `StorageActor = { hubId } | { userId }`):
  - `POST .../uploads` `{ items: [{ objectId, keyVersion, sizeBytes, sha256, replacesVersionId }] }` (até 100) → `{ items: [{ objectId, uploadId, url, headers, expiresAt }] }`; regras e erros da Global Constraints; tudo ou nada por pedido.
  - `POST .../uploads/confirm` `{ uploadIds }` → por item: `head` do provisório (tamanho/sha256 → `upload-mismatch`), reconfere `keyRotationRequired`/versão/conflito **sob trava da linha do objeto**, `copy` para `objects/<objectId>`, grava `s3VersionId`, marca a anterior `superseded_at = now`. Idempotente (Review Focus 2).
  - `POST .../objects/delete` `{ items: [{ objectId, replacesVersionId }] }` (`memory.delete`) → lápide no objeto, `superseded_at` na atual, `deleteCurrent` no S3.
- [ ] Steps: testes (Review Focus 1–3; Hub `space_reader` na Sala → 404; pessoa `space_reader` → 403; troca de chave pendente → 409; versão de chave antiga → 409; conflito entre dois Hubs → 409 no segundo; espaço cheio → 422 com o que falta; objeto > 5 GB → 422; nada de nome em claro em nenhuma coluna), FAIL, implementar, verificação, commit `feat(storage): backup index and uploads`.

### Task 7: Baixar e lixeira

**Files:** `src/storage/application/list-objects.use-case.ts`, `get-download-url.use-case.ts`; rotas; Test `test/storage/downloads.e2e-spec.ts`

**Interfaces:**
- `GET .../objects?since=&cursor=&limit=&include=current|trash|versions` (cursor por id; `since` por `updated_at` do índice, ISO) → itens `{ objectId, deleted, currentVersion: { versionId, keyVersion, sizeBytes, sha256, uploadedAt } | null }`; `include=trash` lista objetos apagados nos últimos 30 dias; `include=versions&objectId=` lista as versões guardadas.
- `POST .../objects/:objectId/versions/:versionId/download` → `{ url, expiresAt }` (15 min). Versão fora da lixeira → 404.
- Quem: Hub na Sala do espaço (qualquer papel) ou pessoa com `memory.read`.
- [ ] Steps: testes (ciclo completo com cifra real: Hub envia, outro Hub reivindicado depois e posto na Sala baixa e abre com `openBackupObject` — "restaurar = reinstalar"; pessoa logada pelo Hub baixa espaço fora da Sala; lixeira mostra o apagado e a versão antiga baixa; Review Focus 4; não membro → 404), FAIL, implementar, verificação, commit `feat(storage): backup listing, downloads and trash`.

### Task 8: Documentação viva e fechamento

**Files:** `CLAUDE.md` (seção `## Módulo storage`; variáveis novas; rate limits das rotas novas se houver; "Pendências": snapshot pago, contratação de franquia, classes mais baratas, troca de chave pelo Hub, visitante, Bluetooth/idioma, limpeza física do índice), `docs/hubs/hub-lifecycle.md` (envio a cada 5 min, fila durante troca de chave pendente, instalação/capacidade, restaurar = reinstalar), DER, spec (status implementada)
- [ ] Atualizar, verificação completa, commit `docs: document storage module`, push, CI verde.
