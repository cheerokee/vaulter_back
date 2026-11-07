# Ciclo de vida do Hub

A sequência completa de um Hub, do primeiro boot ao reset de fábrica, vista do aparelho e do app. É o roteiro para
quem implementa o lado do Hub (`vaulter-hub-back`) e o app.

- Regras e decisões: spec `docs/superpowers/specs/2026-11-01-hubs-design.md`.
- Formato das assinaturas, canonicalização e vetor de teste: `docs/crypto/hub-identity.md`.
- Erros: sempre `application/problem+json`, com `type` estável. Abaixo aparece só o código final do `type` (ex.:
  `claim-code-invalid`).
- Datas em ISO 8601 UTC. Chaves, assinaturas, nonce, desafio e cópias trancadas em base64url sem padding.

## Visão geral

```
 Hub (aparelho)                         Backend                          App (dono / membros)
 1. gera chaves  ─────────────────────▶
 2. POST /hub-enrollments  ───────────▶ apresentação pendente
    ◀──── { enrollmentId, claimCode }
    mostra/fala o código ─────────────────────────────────────────────▶ 3. POST /hubs/claim
 4. GET /hub-enrollments/:id/status ──▶ claimed + hubId
 5. POST /hub-auth/challenge + token ─▶ token de Hub (15 min)
                                                                        6. vínculos com organizações
                                                                        7. espaços no Hub
                                                                        8. liberar na Sala
 9. GET /hub/sync (a cada 5 min) ─────▶ dados das organizações vinculadas
10. pessoas usam o Hub (login online ou senha offline)
                                                                       11. troca de chave do espaço (inclui o Hub)
                                                                       12. desvincular / desregistrar
13. reset de fábrica para reutilizar o aparelho
```

## 1. Primeiro boot

- O Hub gera um par **Ed25519** (identidade, assina mensagens) e um par **X25519** (cifra: recebe as cópias trancadas
  da chave dos espaços).
- As duas chaves privadas ficam no SSD com LUKS e **nunca saem do aparelho**.
- A chave de assinatura identifica o aparelho **para sempre**: depois de reivindicada, ela nunca mais serve para
  outra apresentação, nem depois de desregistrar (veja o passo 13).

## 2. Apresentação (Hub → backend)

`POST /hub-enrollments` (pública, sem token; 20/h por IP)

```json
{
  "signingPublicKey": "<43 chars>",
  "encryptionPublicKey": "<43 chars>",
  "nonce": "<16 bytes aleatórios, 22 chars>",
  "timestamp": "2026-11-02T12:00:00.000Z",
  "signature": "<86 chars: hub-enroll-v1 sobre as duas chaves, o nonce e o timestamp>"
}
```

Resposta 201:

```json
{ "enrollmentId": "<uuid>", "claimCode": "12345678", "expiresAt": "..." }
```

- O `claimCode` (8 dígitos) aparece **só aqui, uma vez**: no banco fica apenas o hash com chave. O Hub mostra ou fala o
  código ao dono. Vale **10 min**.
- **Uma apresentação pendente por chave:** uma apresentação nova expira a anterior da mesma chave. O Hub deve usar
  sempre o código mais recente.
- O `timestamp` precisa estar a **±5 min** do relógio do servidor (o Hub precisa de NTP). O `nonce` é de uso único por
  chave: não reutilize.

| Erro | Status | Quando |
|---|---|---|
| `validation-failed` | 422 | formato de campo inválido |
| `timestamp-invalid` / `timestamp-out-of-window` | 422 | timestamp malformado ou fora de ±5 min |
| `hub-signature-invalid` | 401 | assinatura não confere |
| `nonce-reused` | 409 | o mesmo `nonce` já foi usado com essa chave |
| `signing-key-in-use` | 409 | a chave já pertence a um Hub (mesmo desregistrado): precisa de reset de fábrica |

O Hub guarda `enrollmentId` e `expiresAt`.

## 3. Reivindicação (app do dono → backend)

`POST /hubs/claim` (token de usuário; 30/h por IP **e** 10/h por usuário)

```json
{ "claimCode": "12345678", "name": "Hub da sala" }
```

Numa transação só, o backend:

- cria o Hub, com o usuário como dono e as chaves da apresentação;
- dá `hub_owner` ao dono e `hub_room` à Sala (o próprio aparelho, para a voz ambiente);
- vincula a **organização pessoal do dono, já aprovada**;
- consome a apresentação;
- audita `hub.claimed` na organização pessoal.

| Erro | Status | Quando |
|---|---|---|
| `hub-name-invalid` | 422 | nome vazio ou longo demais (conferido antes do código) |
| `claim-code-invalid` | 422 | código errado, desconhecido, vencido ou já usado: **sempre o mesmo erro** |

Duas reivindicações simultâneas do mesmo código: só uma vence, a outra recebe `claim-code-invalid`.

## 4. O Hub descobre que foi reivindicado

`GET /hub-enrollments/:enrollmentId/status` (pública; 120/h por IP)

Cabeçalhos:

- `X-Hub-Timestamp`: ISO 8601 UTC, ±5 min;
- `X-Hub-Signature`: `hub-status-v1` sobre `{ enrollmentId, timestamp }`.

Respostas 200:

```json
{ "status": "pending" }
{ "status": "expired" }
{ "status": "claimed", "hubId": "<uuid>" }
```

- Id malformado, apresentação inexistente e assinatura ausente ou inválida dão o **mesmo 404**
  `enrollment-not-found`. Só o timestamp malformado ou fora da janela dá 422.
- **Intervalo:** consulte a cada **60 s ou mais**, com jitter, e pare no estado final. Os 120/h por IP são divididos
  entre todos os aparelhos atrás do mesmo NAT.
- `expired`: o código venceu. Volte ao passo 2 (nova apresentação, novo código).
- `claimed`: guarde o `hubId`. A partir daqui o Hub só usa a autenticação do passo 5.

## 5. Autenticação do Hub

Duas chamadas públicas, que **dividem um orçamento de 60/h por IP**:

1. `POST /hub-auth/challenge` com `{ "hubId": "<uuid>" }` → 200 `{ "challenge": "<43 chars>", "expiresAt": "..." }`.
   O desafio vale **60 s** e é de uso único. Um Hub inexistente ou desregistrado recebe um desafio igual na forma,
   que nunca valida.
2. `POST /hub-auth/token` com `{ "hubId", "challenge", "signature" }`, onde `signature` é `hub-auth-v1` sobre
   `{ hubId, challenge }`. Responde 200 `{ "accessToken": "<JWT>", "expiresAt": "..." }`.

- O token é um JWT EdDSA com `typ: hub+jwt`, `sub = hubId`, e vale **15 min**. **Não há refresh:** perto de vencer, o
  Hub repete o par desafio + token (cerca de 8 chamadas por hora).
- Toda falha no token (assinatura errada, desafio vencido, reusado ou falso, Hub desregistrado) dá o **mesmo 401**
  `hub-auth-failed`.
- Rotas de Hub usam `Authorization: Bearer <accessToken>`. A cada requisição o backend confere que o Hub existe e não
  foi desregistrado. Token expirado ou de Hub desregistrado: 401 `invalid-hub-token`.
- Token de Hub em rota de usuário e token de usuário em rota de Hub: 401.

## 6. Vincular organizações

Um vínculo Hub ↔ organização só fica ativo com **dois consentimentos**: o do dono e o da organização. A política da
organização (`hubLinkPolicy`) decide o segundo:

- `any_member_hub` (padrão): o consentimento da organização é automático;
- `admin_approved`: um admin com `org.hubs.approve` precisa aprovar.

A política é sempre avaliada **na hora da decisão**: se a organização a relaxar, o próximo "aprovar" do dono ou de um
admin resolve o pedido pendente.

**O dono vincula uma organização da qual é membro:** `POST /hubs/:id/organizations` com `{ "organizationId" }`. Com
`any_member_hub` o vínculo nasce aprovado; com `admin_approved` fica pendente.

**Outro membro pede o vínculo (código de vínculo):**

1. O Hub pede um código: `POST /hub/link-codes` (token de Hub; 30/h por Hub) → `{ "linkCode": "12345678", "expiresAt" }`.
   São 8 dígitos, válido por 10 min, de uso único. O Hub mostra ou fala o código.
2. A pessoa, no app, chama `POST /hubs/link-requests` com `{ "linkCode", "organizationId" }` (token de usuário; 10/h
   por usuário), para uma organização da qual é membro. Isso prova que ela está diante do aparelho. A resposta **não
   traz o `hubId`**.
3. O dono aprova e, com `admin_approved`, também um admin.

Qualquer falha do código (errado, vencido, usado, de Hub desregistrado) dá o mesmo 422 `link-code-invalid`.

**O admin acha o pedido:** `GET /organizations/:orgId/hub-links?status=pending` (exige `org.hubs.approve`). Devolve
`hubId`, `hubName`, status, quem pediu e os consentimentos, paginado por cursor.

**Decidir:**

- aprovar: `POST /hubs/:id/organizations/:orgId/approve`;
- recusar: `POST /hubs/:id/organizations/:orgId/reject`;
- listar os vínculos do Hub: `GET /hubs/:id/organizations`.

Dono ou admin. Para quem não é dono, Hub inexistente e Hub sem vínculo dão o mesmo 404 `hub-link-not-found`.

## 7. Espaços no Hub

`hub_space` diz quais espaços **moram** no Hub: onde estão os documentos e o RAG, o que o Hub sincroniza e de onde sai
o backup.

- **Pôr:** `POST /hubs/:id/spaces` com `{ "spaceId" }`. Pode o dono, se for membro do espaço, ou um Gestor do espaço,
  se for membro de uma organização com vínculo aprovado. Sem vínculo aprovado: 422 `organization-not-linked`.
- **Tirar:** `DELETE /hubs/:id/spaces/:spaceId` (o dono tira qualquer espaço; um Gestor tira o próprio). Tirar
  também tira o espaço da Sala.
- **Listar:** `GET /hubs/:id/spaces` (cursor).

## 8. Liberar um espaço na Sala

A Sala é o próprio Hub agindo sem login (voz ambiente). Para ela ler um espaço, o app tranca a chave do espaço para o
Hub, como faria para uma pessoa.

`PUT /hubs/:id/spaces/:spaceId/room` (o dono, que precisa ser **Gestor** do espaço)

```json
{
  "roleKey": "space_reader",
  "recoveryPublicKey": "<kit atual da organização, 43 chars>",
  "grants": [{ "version": 1, "wrappedKey": "<108 chars>" }]
}
```

- `grants` traz **todas** as versões da chave do espaço, seladas (`crypto_box_seal`) para a `encryptionPublicKey` do
  Hub. O app a obtém em `GET /hubs/:id`.
- `roleKey`: `space_reader` (padrão) ou `space_editor`.
- O espaço precisa já estar no Hub (422 `space-not-on-hub`).
- A organização precisa permitir espaços na Sala (`allowRoomSpaces`): sem isso, uma liberação **nova** dá 422
  `room-not-allowed`. Liberar de novo ou trocar o papel de um Hub que já está na Sala continua permitido.
- O Hub conta no limite de membros do espaço (`SPACE_MAX_MEMBERS`).
- **Tirar da Sala:** `DELETE /hubs/:id/spaces/:spaceId/room` (dono ou Gestor). Grava lápide no papel e nas cópias e
  marca a troca de chave pendente no espaço.

## 9. Sincronização (Hub → backend)

`GET /hub/sync?since=<n>&limit=<1..500>` (token de Hub; 120/h por Hub)

```json
{
  "items": [{ "type": "member", "syncVersion": "123", "deleted": false, "data": {} }],
  "nextSince": "123"
}
```

- **Tipos de item:** `hub`, `hub_organization`, `organization`, `member`, `role_assignment`, `space`, `space_key`,
  `space_key_grant`, `hub_space`. O formato de `data` de cada tipo está no comentário de
  `src/hubs/application/sync-hub.use-case.ts`.
- **Escopo:** só organizações com vínculo **aprovado**, só espaços em `hub_space`, e só as cópias da chave para
  pessoas ou para **este** Hub. Nunca `authHash`, a cópia do kit nem cópias de outro Hub. `member` traz o material
  trancado (`publicKey`, `encryptedPrivateKey`, `kdfSalt`, `kdfParams`) para o login offline.
- **Lápides:** `deleted: true` traz só as chaves do item. O Hub apaga localmente o item e, em cascata, o que depende
  dele:
  - lápide de `hub_organization` (o vínculo foi revogado, recusado ou voltou a ficar pendente) → o Hub apaga tudo
    daquela organização: membros, papéis, espaços, chaves e cópias;
  - lápide de `hub_space` → o Hub apaga aquele espaço e o que depende dele.
- **Paginação:**
  - guarde o `nextSince` e mande-o como `since` na próxima chamada;
  - página cheia (`items.length == limit`) significa que há mais: peça a seguinte na mesma passada;
  - a página só passa de `limit` quando um grupo de itens com o mesmo `syncVersion` é maior que ele.
- **Sincronização completa (`since=0`):** **substitui** todo o estado local do Hub. Faça uma:
  - na primeira vez;
  - depois de mais de 30 dias sem sincronizar;
  - quando, numa passada incremental, chegar algo **entrando no escopo**: um vínculo aprovado ou um `hub_space` vivo
    que o Hub não tinha. As linhas antigas daquela organização ou espaço mantêm o `syncVersion` antigo e não viriam
    na incremental.
- **Intervalo:** incremental a cada **5 min**, com jitter de ±20% (12 por hora), sempre com `limit=500`. Com 429,
  espere o `Retry-After`; nunca repita em laço apertado.

## 10. Pessoas usando o Hub

- **Online:** a pessoa faz o login normal do `identity` (`/auth/prelogin` + `/auth/login`), com
  `device.platform = 'hub'`. Não há rota nova.
- **Offline:** o Hub tem o material trancado da pessoa (vindo da sincronização). A senha deriva a chave (Argon2id,
  `docs/crypto/user-keys.md`) e abre a chave privada dela, que abre as cópias da chave dos espaços.
- **Sala:** sem login, o Hub abre com a própria chave X25519 as cópias trancadas para ele (passo 8).
- **Papéis no Hub:** o dono atribui `hub_operator` ou `hub_user` a membros das organizações vinculadas, por
  `PUT /hubs/:id/roles/:userId` com `{ "roleKey" }`, e remove por `DELETE /hubs/:id/roles/:userId` (204, idempotente).
  Membros das organizações vinculadas já são `hub_user` implicitamente.

## 11. Troca da chave de um espaço (app)

Quando alguém sai do espaço ou da organização, ou um Hub sai da Sala, o espaço fica com a troca de chave pendente. Na
troca (`POST /spaces/:id/keys`), o app precisa mandar uma cópia da versão nova para cada membro **e para cada Hub da
Sala**:

1. `GET /spaces/:id` traz `roomHubs: [{ hubId, roleKey }]`;
2. `GET /hubs/:hubId` traz a `encryptionPublicKey` de cada um;
3. a troca leva `hubGrants: [{ hubId, wrappedKey }]` com **exatamente** esses Hubs. Conjunto errado: 409
   `key-rotation-mismatch`, com `expectedHubIds`, `missingHubIds` e `unexpectedHubIds` no corpo.

O Hub recebe a versão nova na próxima sincronização. Um Hub desvinculado ou desregistrado já saiu da Sala e não a
recebe.

## 12. Saídas: desvincular, sair, desregistrar

Todas são atômicas: se algo falha, nada muda.

- **Desvincular** (`DELETE /hubs/:id/organizations/:orgId`, dono ou admin):
  - o vínculo fica revogado;
  - os espaços da organização saem do Hub;
  - a Sala e as cópias desses espaços caem, e a troca de chave fica pendente;
  - perdem o papel no Hub as pessoas que ficaram sem nenhuma organização vinculada.

  O Hub vê a lápide do vínculo na próxima sincronização e apaga tudo daquela organização.
- **O dono sai de um espaço:** as liberações desse espaço na Sala dos Hubs dele caem.
- **Uma pessoa sai da organização:** perde o papel no Hub se ficou sem organização vinculada. Se for o dono do Hub,
  os Hubs dele são desvinculados dessa organização.
- **Desregistrar** (`DELETE /hubs/:id`, só o dono): lápide no Hub, em todos os vínculos, espaços e papéis, e a Sala
  cai em toda organização a que o Hub já foi vinculado. Audita `hub.deregistered`. A partir daí:
  - a autenticação do Hub falha (`hub-auth-failed`) e o token em uso deixa de valer (401);
  - o backend não avisa o Hub (não há canal de push ainda) e, de propósito, o erro não diz "desregistrado" (seria um
    oráculo). O Hub que recebe `hub-auth-failed` repetidamente com as próprias chaves intactas deve entender que foi
    desregistrado, apagar os dados locais e pedir o reset de fábrica.

- **Desregistro forçado pela plataforma:** se o dono perdeu a conta (e a recuperação pelo código não resolve), o Hub
  fica preso nela. A equipe Vaulter faz o desregistro por um pedido de suporte (`hub_force_deregister`, módulo
  `platform`, com motivo e prova, aprovação dupla para o suporte). O efeito é **idêntico** ao do dono, e as organizações
  vinculadas veem a ação em `audit_logs` com `user_id` nulo e `metadata { actor: 'platform', supportRequestId }`. Para o
  aparelho nada muda: `hub-auth-failed`, depois reset de fábrica e nova reivindicação com a conta nova (passo 13).

Outras rotas do dono: `GET /hubs` (Hubs que a pessoa vê, por cursor), `GET /hubs/:id` e `PATCH /hubs/:id` com
`{ "name" }`.

## 13. Reset de fábrica

Um aparelho desregistrado **não pode ser reivindicado de novo com as mesmas chaves**: a apresentação dá 409
`signing-key-in-use`. Para reutilizá-lo, pelo mesmo dono ou por outro:

1. apagar o SSD (dados e chaves);
2. voltar ao passo 1, com chaves novas.

Assim nada do dono anterior chega a um dono novo.

## Limites de requisição (resumo)

| Rota | Limite | Chave |
|---|---|---|
| `POST /hub-enrollments` | 20/h | IP |
| `GET /hub-enrollments/:id/status` | 120/h | IP |
| `POST /hub-auth/challenge` + `POST /hub-auth/token` | 60/h somados | IP |
| `POST /hubs/claim` | 30/h e 10/h | IP e usuário |
| `POST /hubs/link-requests` | 10/h | usuário |
| `POST /hub/link-codes` | 30/h | Hub |
| `GET /hub/sync` | 120/h | Hub |
| demais rotas | 300/min somando todas | IP |

Estourou: 429 `too-many-requests` com `Retry-After` (segundos).

## Pendências que afetam o Hub

- **WebSocket Hub ↔ backend:** hoje o Hub só puxa (status e sincronização por HTTP). Notificações em tempo real e
  comandos para o aparelho entram com o canal WebSocket.
- **Apagamento remoto:** não há comando para o backend mandar o Hub se apagar. O desregistro só corta o acesso.
- **Transferência de Hub:** não existe. Hoje o caminho é desregistrar e fazer reset de fábrica.
- **Ordem de commit × `sync_version`:** uma sincronização pode pular de vez uma linha cujo commit chegou atrasado.
  Até a correção (horizonte seguro), a sincronização completa periódica corrige o estado.
