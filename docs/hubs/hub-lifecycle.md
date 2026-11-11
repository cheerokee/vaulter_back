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
    envio do backup (a cada 5 min) ───▶ índice + S3; listagem completa 1x por dia
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

### Capacidade do SSD

Logo depois de autenticar, e sempre que mudar (SSD trocado, partição redimensionada), o Hub informa quanto do SSD pode
usar: `PUT /hub/storage` (token de Hub) com `{ "capacityBytes": <inteiro> }`, de **1 GiB a 64 TiB** (fora disso, 422
`validation-failed`). Responde **204**. Um valor menor que o já reservado pelos espaços instalados é aceito: só as
próximas instalações são recusadas. Hub que nunca informou: instala sem conferência (software antigo não trava).

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
  **Capacidade** ("como um console"): com a capacidade informada (§5), a soma dos tamanhos reservados
  (`storageQuotaBytes`) dos espaços já instalados, de **todas** as organizações, mais o novo, precisa caber; senão 422
  `hub-storage-full` (com `missingBytes` só para o dono do Hub: a soma conta outras organizações; quem não é dono recebe
  o erro sem números). Pôr de novo um espaço que já está no Hub não conta duas vezes.
- **Aumentar o tamanho** de um espaço instalado (`PUT /spaces/:id/storage-quota`, Gestor) também confere cada Hub onde
  ele está: 422 `hub-storage-full` com `hubId` (e `missingBytes` só para o dono do Hub). Raro: 409 `hub-storage-busy` quando outra instalação
  no mesmo Hub acontece no mesmo instante (repetir).
- **Ver:** `GET /hubs/:id` traz `storage: { capacityBytes, reservedBytes }` (`capacityBytes` nulo até o Hub informar;
  o reservado conta os espaços que quem consulta vê: o dono, todos).
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
  `src/hubs/application/sync-hub.use-case.ts`. O item `space` traz `cloudMode` (`encrypted_backup` | `active_cloud`) e
  `allowOnlineLlm`: é por ele que o Hub sabe se o espaço está em **nuvem ativa** (espelhos de conector no backup,
  manifesto da nuvem, cópia do servidor nos assuntos; veja "Nuvem ativa: o que muda para o Hub").
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

### Backup dos espaços (envio)

O Hub envia as mudanças dos espaços **a cada 5 min**, na mesma passada da sincronização (spec
`docs/superpowers/specs/2026-11-09-storage-backup-design.md` §4.2). Cada objeto é um blob cifrado com a chave do espaço
(`docs/crypto/space-backup.md`); o `objectId` (UUID v7) é do Hub e estável (arquivo atualizado = versão nova do mesmo
objeto). O backend guarda só o índice (ids, tamanho, sha256 do blob, versão da chave), nunca nome de arquivo. O que é
cada objeto (nome, tipo, origem, partes em ordem) fica no **manifesto do espaço**, um objeto cifrado com `objectId`
fixo (UUID v5 do `spaceId`), no formato de `docs/hubs/space-manifest.md`: a nuvem ativa depende dele para indexar o
espaço, e nos espaços em nuvem ativa os espelhos de conector também entram no backup (mesmo documento). **O manifesto
lista só documentos**: assuntos, eventos, pedaços do índice local e qualquer outro objeto interno do Hub **nunca** entram
nele (a nuvem indexaria o que estiver listado para todos os membros; veja "O que nunca entra no manifesto"). Além de UUID v7,
o backend aceita só o id do manifesto do Hub daquele espaço (outro UUID: 422 `object-id-invalid`); o id do manifesto da
nuvem é reservado ao servidor (enviar ou apagar com ele: 422 `object-id-reserved`).

- **Quem envia e apaga** (`memory.write`; apagar é a mesma permissão de substituir): com o token do Hub, só nos espaços
  da **Sala** dele com papel `space_editor` (`/hub/spaces/:spaceId/...`); com o token da pessoa logada nele
  (`/spaces/:spaceId/backup/...`), nos espaços em que ela é `space_editor`/`space_manager`. Sala de leitor ou espaço fora
  da Sala: 404 `space-not-found`; pessoa leitora: 403. **Apague no backup o que o Hub apagou localmente** (conversas,
  eventos, pedaços do índice): o que não for apagado volta vivo numa restauração.
- **1. Intenção:** `POST .../uploads` `{ items: [{ objectId, keyVersion, sizeBytes, sha256, replacesVersionId }] }`
  (até 100; tudo ou nada) → `{ items: [{ objectId, uploadId, url, headers, expiresAt }] }`. `replacesVersionId` é a
  versão que o envio substitui (`null` para objeto novo ou apagado). A intenção reserva o tamanho no espaço por 1 dia;
  uma intenção nova do mesmo objeto pelo mesmo Hub encerra a anterior.
- **2. Bytes:** `PUT` direto no S3 na `url` (vale 15 min) com **exatamente** os `headers` devolvidos (tamanho, checksum
  e a marca do provisório fazem parte da assinatura).
- **3. Confirmação:** `POST .../uploads/confirm` `{ uploadIds }` (até 100; tudo ou nada; **idempotente**: repetir depois
  de um timeout devolve a mesma versão; só quem pediu a intenção confirma, com o mesmo token de Hub ou da mesma pessoa) → `{ items: [{ uploadId, versionId, objectId, keyVersion, sizeBytes, sha256,
  uploadedAt }] }`. `versionId` = `uploadId`; guarde-o como a versão atual do objeto. **Um pedido de confirmação copia
  no máximo 5 GiB** (soma dos `sizeBytes` declarados do que ainda não foi confirmado): acima disso, 422
  `confirm-batch-too-large` (`maxBytes`, `requestedBytes`); confirme em lotes menores (um objeto sempre cabe).
- **Apagar:** `POST .../objects/delete` `{ items: [{ objectId, replacesVersionId }] }` → 204 (o objeto fica 30 dias na
  lixeira).
- **Não reenvie o que não mudou.** Toda versão substituída e todo objeto apagado ficam **30 dias na lixeira e contam no
  uso do espaço**: um arquivo grande reenviado com frequência enche o espaço sozinho (um manifesto de 10 MB a cada 5 min
  são ~86 GB por mês) e o backup para (422 `space-storage-full`). Por isso: compare o `sha256` com o da versão atual
  antes de enviar e pule o que não mudou; conteúdo que muda sempre (conversas, eventos, índice) vai em **pedaços
  imutáveis** ou deltas (objeto novo por pedaço, nunca o arquivo inteiro de novo); o manifesto fica **pequeno** (só
  referências aos pedaços).
- **Controle da lixeira:** cada objeto guarda no máximo **10 versões antigas**: ao confirmar uma versão nova, as
  substituídas além das 10 mais recentes são apagadas de vez (somem de `include=versions` e o download delas dá 404
  `version-not-found`). Objeto apagado guarda as versões os 30 dias inteiros. O **Gestor** pode **esvaziar a lixeira**
  do espaço pelo app (`POST /spaces/:spaceId/backup/trash/empty` `{ currentAuthProof }`, só token de usuário, com
  reautenticação; até 1000 versões por pedido → `{ purgedVersions, purgedBytes, remainingVersions }`, repita enquanto
  `remainingVersions > 0`; um pedido que não apaga nada responde `remainingVersions: 0`); a versão viva nunca é
  apagada. Não há rota de Hub para isso. **Cada pedido gasta o orçamento de reautenticação** (5 por 15 min, dividido
  com troca de senha e afins): um Gestor apaga até **5000 versões por 15 min**. O app deve explicar que uma lixeira
  muito grande leva várias rodadas (com 429, esperar o `Retry-After`); no uso normal o limite de 10 versões por objeto
  mantém a lixeira pequena. Enquanto um pedido roda, confirmações e apagamentos do Hub nos objetos do lote podem
  receber 409 `storage-busy` (repita).
- **Avisos no app (recomendação):** `GET /spaces/:id` traz `storage: { quotaBytes, usedBytes, trashBytes }`. Avise o
  Gestor quando `usedBytes` passar de **80%** de `quotaBytes` e a lixeira (`trashBytes`) for parte relevante disso,
  oferecendo **"esvaziar a lixeira"** ou **"aumentar o espaço"** (`PUT /spaces/:id/storage-quota`); e avise que o
  **backup parou** quando um envio for recusado com 422 `space-storage-full`. Os limiares ficam no app.
- **Erros:** troca de chave pendente → 409 `space-key-rotation-required` (guarde as mudanças numa **fila local** e envie
  depois que um membro trocar a chave pelo app); versão da chave antiga → 409 `space-key-version-stale` (cifre de novo com
  a versão atual); outro Hub gravou antes → 409 `object-version-conflict` (com `currentVersionId`; resolva, por exemplo,
  gravando uma cópia de conflito como objeto novo); espaço cheio → 422 `space-storage-full` (`missingBytes`); objeto
  acima de 5 GiB → 422 `object-too-large` (divida o arquivo); bytes no S3 diferentes do declarado ou PUT não feito →
  422 `upload-mismatch`; `uploadId` desconhecido, de outro espaço, de outro remetente ou com mais de 1 dia → 404 `upload-not-found`;
  409 `storage-busy` (raro: o espaço ou o objeto ficou travado mais de 10 s por outro pedido, por exemplo uma
  confirmação grande) → repita o mesmo pedido depois de alguns segundos, com jitter.

### Backup dos espaços (listar, baixar, restaurar)

- **Quem lê:** com o token do Hub, os espaços da **Sala** dele com **qualquer** papel (`/hub/spaces/:spaceId/...`);
  com o token da pessoa logada nele, qualquer espaço de que ela é membro, **mesmo fora da Sala**
  (`/spaces/:spaceId/backup/...`). Fora disso: 404 `space-not-found`.
- **Listar:** `GET .../objects?include=current&since=&cursor=&limit=` (`limit` até 1000, padrão 100) →
  `{ items: [{ objectId, deleted, deletedAt, currentVersion: { versionId, keyVersion, sizeBytes, sha256, uploadedAt } | null }], nextCursor, asOf }`.
  Sem `since`: só os objetos vivos. Com `since` (ISO 8601): o que mudou desde então, **inclusive apagados**
  (`deleted: true`, `currentVersion: null`: apague localmente). Siga `nextCursor` até `null`; guarde o `asOf` da
  **primeira** página e use **`asOf` menos 1 hora** como o próximo `since`; repetir um item é inofensivo. A folga é
  garantida: o backend carimba a mudança no relógio do banco depois de todo o trabalho no S3, e a transação que não
  confirmar em até 5 min depois do carimbo é derrubada (nunca entra), então nenhuma mudança confirmada fica mais de
  5 min "no passado".
- **Listagem completa (substitui o estado local):** **uma vez por dia** (com jitter) e sempre que o Hub perder o
  `since` (estado local perdido, ficou mais de 30 dias sem listar), liste tudo **sem `since`**: o resultado é o estado
  vivo inteiro. Só é tratado como **apagado** (vai para a lixeira local do Hub) o objeto local que o Hub **já viu
  confirmado** no backup (guarda um `versionId` dele: confirmou o envio ou recebeu numa listagem) e que **não** veio
  nela como vivo. **Nunca apague por uma listagem o que ainda não subiu:** a fila local da troca de chave pendente,
  envios em andamento (intenção feita, confirmação não), cópias de conflito ainda não enviadas e qualquer objeto sem
  `versionId` confirmado ficam como estão e seguem na fila de envio. É a rede de segurança para qualquer mudança
  perdida, inclusive apagamentos.
- **Lixeira:** `include=trash` (apagados há menos de 30 dias e ainda não esvaziados, com a última versão em `currentVersion`) e
  `include=versions&objectId=<id>` (as versões guardadas do objeto, a mais antiga primeiro, com `supersededAt` e
  `current`). Restaurar da lixeira = baixar a versão e **reenviar** como versão nova (não existe "desapagar").
- **Baixar:** `POST .../objects/:objectId/versions/:versionId/download` → `{ url, expiresAt }`: `GET` direto no S3 na
  `url` (15 min); abra com a chave da versão `keyVersion` do espaço (`docs/crypto/space-backup.md`) e confira o
  `sha256` do blob. Versão desconhecida, pendente, fora da lixeira ou apagada de vez (lixeira esvaziada ou além das 10
  versões antigas): 404 `version-not-found`.
- **Restaurar = reinstalar:** Hub queimado → reivindicar o novo, vincular, pôr os espaços e liberar na Sala (§8). O
  Hub recebe a cópia da chave de cada versão pela sincronização (`space_key_grant` com o próprio `hubId`), lista
  tudo (`limit=1000`, sem `since`) e baixa cada versão atual. Respeite os limites (abaixo); com 429, espere o
  `Retry-After`.

## 10. Pessoas usando o Hub

- **Online (login pelo Hub):** o Hub pede o salt e os parâmetros da pessoa (`POST /auth/prelogin`, rota comum),
  deriva a prova da senha (`docs/crypto/user-keys.md`) e faz o login **com o token de Hub**:
  `POST /hub/user-sessions` com `{ "email", "authProof", "device": { "name" } }` (o `device` só tem o nome; a
  plataforma é sempre `hub`). Resposta 200 igual à do `/auth/login`: `user`, `keys` (chave privada trancada, salt,
  parâmetros) e `session` (`sessionId`, `accessToken`, `refreshToken` e as validades). Daí em diante é uma sessão comum
  de usuário (`/auth/refresh`, `/auth/logout`, rotas de usuário com o `accessToken`), **com uma exceção nos
  assuntos**: por essa sessão a pessoa só alcança os assuntos cujo **executor é este Hub** (os outros dão 404
  `conversation-not-found` e não aparecem no `GET /conversations/changes`; criar só com este Hub como executor). Quando
  o Hub deixa de ser executor de um assunto (lápide da própria cópia no feed de executor), apague-o também da visão da
  pessoa.
  - **Só entra quem tem papel no Hub:** dono, `hub_operator`/`hub_user` explícito ou `hub_user` implícito (membro ativo
    de organização com vínculo aprovado). Quem não tem papel recebe o **mesmo** 401 `invalid-credentials` da senha
    errada e do e-mail desconhecido (sem oráculo). O Hub também confere localmente (conhece os membros pela
    sincronização); o backend é a segunda trava.
  - **`/auth/login` com `device.platform = 'hub'` dá 401 `invalid-credentials`** (e o cadastro e a recuperação da conta
    com `hub`, 422 `device-invalid`, antes de conferir qualquer prova): sessão de Hub só nasce por esta rota.
  - **A sessão fica presa ao Hub** e cai sozinha (o refresh passa a dar 401 `invalid-refresh-token`; o motivo gravado é
    `hub_access_lost`) quando a pessoa perde todo papel nele: desvincular a organização que dava o papel, a pessoa sair
    ou ser removida da organização, o dono tirar o papel explícito de quem não tem outro (hoje quem tem papel
    explícito segue `hub_user` implícito, então a sessão continua), ou o Hub ser desregistrado (todas as sessões do
    Hub, inclusive a do dono). Sessões da mesma pessoa em outros aparelhos ou em outros Hubs não mudam. Ao receber 401
    no refresh, o Hub descarta a sessão e pede a senha de novo (se ainda tiver papel, entra).
  - Limites: 10/min por Hub e 5/min por e-mail (a mesma regra do `/auth/login`, com o Hub no lugar do IP). O contador
    por e-mail desta rota é **separado** do contador por e-mail do `/auth/login` (cada rota tem o seu).
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
   `key-rotation-mismatch`, com `expectedHubIds`, `missingHubIds` e `unexpectedHubIds` no corpo;
4. num espaço em **nuvem ativa** (`cloudMode = "active_cloud"`), a troca leva também `serverWrappedKey` (a versão nova
   selada para `GET /cloud/server-key`); sem ela 409 `key-rotation-mismatch` com `missingServer: true`. A nuvem nunca
   aparece na sincronização do Hub (a cópia do servidor não vai a nenhum feed).

O Hub recebe a versão nova na próxima sincronização. Um Hub desvinculado ou desregistrado já saiu da Sala e não a
recebe.

## 12. Saídas: desvincular, sair, desregistrar

Todas são atômicas: se algo falha, nada muda.

- **Desvincular** (`DELETE /hubs/:id/organizations/:orgId`, dono ou admin):
  - o vínculo fica revogado;
  - os espaços da organização saem do Hub;
  - a Sala e as cópias desses espaços caem, e a troca de chave fica pendente;
  - perdem o papel no Hub as pessoas que ficaram sem nenhuma organização vinculada;
  - as sessões presas ao Hub de quem ficou sem papel nele caem (passo 10).

  O Hub vê a lápide do vínculo na próxima sincronização e apaga tudo daquela organização.
- **O dono sai de um espaço:** as liberações desse espaço na Sala dos Hubs dele caem.
- **Uma pessoa sai da organização:** perde o papel no Hub se ficou sem organização vinculada, e as sessões dela
  presas a esse Hub caem. Se for o dono do Hub, os Hubs dele são desvinculados dessa organização (e caem as sessões de
  quem ficou sem papel neles).
- **Desregistrar** (`DELETE /hubs/:id`, só o dono): lápide no Hub, em todos os vínculos, espaços e papéis, e a Sala
  cai em toda organização a que o Hub já foi vinculado; toda sessão de pessoa aberta pelo Hub cai. Audita
  `hub.deregistered`. A partir daí:
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

## Assuntos (conversas): o Hub como executor

O Hub como executor dos assuntos (spec `2026-11-09-conversations-design.md`; formato da cifra em
`docs/crypto/conversations.md`). Resumo do ciclo do executor: (1) **acompanhar o feed** com sondagem longa; (2) para cada
mensagem de pessoa `pending`, **pegar e confirmar (`ack`)**; (3) responder com mensagens e anexos cifrados com a chave
do assunto; (4) **trocar a chave** quando o assunto pedir (alguém saiu); (5) apagar o que tem localmente ao perder o
posto. O Hub só vê assuntos em que é o executor (o dono dele participa, o espaço está instalado nele e o vínculo da
organização está aprovado). Rotas com o token de Hub:

- `GET /hub/conversations/changes?since=&limit=&wait=&conversationId=`: o **feed de mudanças** do executor, com
  **sondagem longa**. Resposta `{ organizationIds, items: [{ type, syncVersion, deleted, data }], nextSince }`, no
  mesmo padrão do `GET /hub/sync` (ordem de `sync_version`, `limit` 1..500, padrão 500; lápide leva só as chaves).
  Tipos: `conversation`, `conversation_participant`, `conversation_key_grant` (só as cópias **do próprio Hub**),
  `conversation_message` (com o corpo cifrado) e `conversation_attachment` (metadado). Só os assuntos em que o Hub é
  executor, só nas organizações com vínculo **aprovado** (`organizationIds`). `wait` (0..25 s, padrão 0): com a página
  vazia, o pedido fica aberto até chegar uma mudança (acorda em menos de 1 s, por `LISTEN/NOTIFY` do Postgres) ou o
  tempo acabar, e responde a página (vazia no tempo esgotado). **Laço recomendado:** `wait=25` com o `nextSince`
  anterior, de novo logo que a resposta chegar; com página cheia, pedir a seguinte com `wait=0`; erro de rede ou 5xx:
  esperar alguns segundos (com jitter) antes de repetir; 429: o `Retry-After`. No máximo **2 sondagens abertas por
  Hub** (a terceira responde na hora, sem esperar).
  **O que o Hub faz com o feed:**
  - lápide de uma cópia **própria** (`conversation_key_grant` com `hubId` = o Hub) = o Hub **deixou de ser executor**:
    apagar localmente o assunto, as mensagens, os anexos e as chaves; lápide de `conversation` = o mesmo;
  - organização que sai de `organizationIds` = apagar os assuntos dela (as lápides não vêm mais);
  - **assunto que entra no escopo** (um `conversation` vivo que o Hub não tinha: virou executor de um assunto antigo,
    ou o Hub foi escolhido como executor de um assunto já existente): o histórico tem `sync_version` antigo e **não**
    reaparece no cursor principal, então o Hub faz o **preenchimento** buscando o assunto inteiro com
    `conversationId=<id>&since=0` (páginas até vir vazia) e segue com o cursor principal;
  - sincronização completa (`since=0`) **substitui** o estado local. Este feed **não** pula linhas pela ordem de commit
    (a versão é dada no COMMIT, na ordem dos commits: o que confirmou já sai na próxima leitura, e o que confirmar depois
    vem sempre com versão maior), então não precisa de sincronização completa periódica. `syncVersion` aqui não é comparável com o do `GET /hub/sync` (são outra ordem).
  - mensagem com `replacesMessageId` = edição: esconder a substituída (a lápide dela chega na mesma página ou depois,
    nunca antes);
  - **itens filhos de um assunto que o Hub ainda não conhece** (mensagem, anexo, participação ou cópia) **podem chegar
    antes do item `conversation`** (a ordem é só por `sync_version`): guarde-os e aplique quando o `conversation`
    chegar (na mesma passada ou na seguinte); não descarte nem trate como erro;
  - **caixa de entrada:** toda `conversation_message` com `pending: true` e autor pessoa é trabalho a pegar; depois de
    guardar localmente, chame o `ack` (abaixo). Confirmar de novo é seguro. **Contrato do ack:** só execute a mensagem
    depois do **200** do ack (é ele que diz que ela é sua); ack com **404** (`conversation-not-found`: você não é mais o
    executor; `message-not-found`: apagada) = **descarte** a mensagem sem executar. Um Hub que vira executor trata
    toda mensagem `pending` como trabalho, inclusive as que o executor anterior confirmou e não respondeu: quando o
    executor troca ou se perde (troca pelo dono, desvínculo, desregistro, espaço tirado do Hub, dono do Hub saindo do
    assunto), o backend devolve a `pending` toda mensagem que o Hub antigo confirmou sem mandar nenhuma mensagem dele
    depois no assunto (ela chega de novo no feed com `pending: true`);
  - **nuvem de reserva** (espaço em nuvem ativa; spec active-cloud §4.3): o item `conversation` traz `cloudReserve`.
    Com ela ligada, a nuvem também pode pegar uma mensagem `pending`: **o primeiro ack vale** (contrato completo em
    "A nuvem como executor de reserva", abaixo). Se a nuvem pegou antes, o ack do Hub dá **404** `message-not-found`
    (descarte, nunca execute) e a mensagem chega no feed com `pending: false` e `ackedByCloud: true`. A resposta da
    nuvem é uma `conversation_message` com `authorCloud: true` (nasce confirmada). Uma mensagem que a nuvem confirmou e
    ainda não respondeu continua sendo dela (o ack do Hub segue 404) até a reserva cair. Quando a reserva cai (o dono
    desliga, o espaço sai da nuvem ativa), o que a nuvem confirmou sem responder volta a `pending` e é trabalho do Hub;
  - **troca de chave pelo executor:** quando o item `conversation` vier com `keyRotationRequired: true`, o Hub **não
    pode mandar mensagem nem anexo** (409 `conversation-key-rotation-required`); ele (ou qualquer participante) faz a
    troca com `POST /hub/conversations/:id/keys`, e o assunto volta a aceitar mensagens. Enquanto pendente, guarde o que
    for enviar numa fila local. Com `cloudReserve: true`, a troca leva também `serverWrappedKey` (a versão nova selada
    para a chave pública do servidor, `GET /hub/cloud/server-key` com o token de Hub); sem ela 409
    `key-rotation-mismatch` com `missingServer: true` (sem a reserva, mandar a cópia dá `unexpectedServer: true`).

- `POST /hub/conversations` `{ id, spaceId, ownerUserId, state?, encryptedHeader, grants: [{ userId, wrappedKey }],
  hubWrappedKey, serverWrappedKey? }`: o Hub abre um assunto (o "aviso", `state` padrão `aviso`) em nome de uma pessoa com papel no Hub e
  membro do espaço, sendo ele o executor. `grants` = a versão 1 da chave trancada para cada participante: a pessoa e,
  se não for ela, o **dono do Hub** (regra do executor). Espaço que não está no Hub, vínculo não aprovado ou dono do
  Hub fora das `grants`: 422 `executor-invalid`; participante fora do espaço: 422 `participant-not-space-member`.
  Mandar de novo o mesmo `id` devolve o mesmo assunto (200). **Espaço em nuvem ativa** (spec active-cloud §4.3, sem
  exceção para o Hub): o assunto nasce com a nuvem de reserva e o pedido leva também `serverWrappedKey` (a versão 1
  selada para a pública do servidor, `GET /hub/cloud/server-key`); sem ela 422 `cloud-reserve-copy-required`; fora da
  nuvem ativa, mandar a cópia é 422 `cloud-reserve-unavailable`; cópia que não abre com a chave do servidor, 422
  `server-copy-invalid`. O Hub sabe se o espaço está em nuvem ativa pelo `cloudMode` do item `space` do `GET /hub/sync`
  (e, se a sincronização estiver atrasada, recebe o 422 e tenta de novo do jeito certo).
- `GET /hub/conversations/:id`: metadado, participantes e as cópias da chave do próprio Hub (todas as versões).
- `PUT /hub/conversations/:id/header` `{ keyVersion, encryptedHeader }`: o executor troca o cabeçalho cifrado (título,
  plano; `docs/crypto/conversations.md`, rótulo do cabeçalho, `recordId` = id do assunto) com a versão **atual** da
  chave (409 `conversation-key-version-stale`; com troca pendente, 409 `conversation-key-rotation-required`). Os bytes
  contam no uso do espaço (422 `space-storage-full`). Devolve o assunto.
- `PUT /hub/conversations/:id/state` `{ state }`: os estados de trabalho (`trabalhando`, `na_fila`, `pede_sim`,
  `esperando_pc`, `concluido`, `aviso`); `arquivado` é do dono (403 `not-conversation-owner`).
- `POST /hub/conversations/:id/keys` `{ version, grants: [{ userId, wrappedKey }], hubGrants: [{ hubId, wrappedKey }],
  serverWrappedKey? }`: com a troca pendente (`keyRotationRequired`, alguém saiu), o Hub pode fazer a troca: versão
  atual + 1 para **exatamente** os participantes vivos e ele mesmo (409 `key-rotation-mismatch` com os ids
  faltando/sobrando), e para o servidor **exatamente** quando `cloudReserve: true` (`serverWrappedKey`, a versão nova
  selada para `GET /hub/cloud/server-key`; 409 com `missingServer` / `unexpectedServer`). A nuvem nunca troca a chave de
  um assunto: com a reserva ligada e a troca pendente, ela não pega mensagens até o Hub ou um participante trocar.
- `GET /hub/cloud/server-key` -> `{ publicKey }` (token de Hub): a chave pública X25519 do servidor (43 caracteres
  base64url) para selar `serverWrappedKey` (`0x01 ‖ crypto_box_seal`, 108 caracteres, como as cópias para Hubs).
  **Busque de novo antes de selar** (não guarde por muito tempo): numa rotação a pública muda, e uma cópia selada para
  uma chave desconhecida dá 422 `server-copy-invalid`.

- `POST /hub/conversations/:id/messages` `{ id, keyVersion, encryptedBody, replacesMessageId? }`: a mensagem do Hub,
  cifrada com a chave do assunto (`docs/crypto/conversations.md`, rótulo `conversation-message`, `recordId` = id da
  mensagem, UUID v7 gerado no Hub), até 64 KiB cifrados (maior: 422 `message-too-large`; vira anexo). Nasce confirmada
  (`pending: false`). 201; **mandar de novo** o mesmo `id` com o mesmo conteúdo devolve a mesma resposta (200), então
  depois de uma falha de rede é seguro repetir; o mesmo `id` com outro conteúdo (ou já usado em outro lugar): 409
  `message-id-conflict`. `keyVersion` tem de ser a atual (409 `conversation-key-version-stale` com `expectedVersion`);
  com troca pendente: 409 `conversation-key-rotation-required` (faça a troca antes). Espaço cheio: 422
  `space-storage-full` (`missingBytes`; o texto das mensagens conta no tamanho do espaço, junto com o backup).
  `replacesMessageId` edita uma mensagem do próprio Hub (ela vira lápide).
- `POST /hub/conversations/:id/messages/:messageId/ack`: caixa de entrada; o Hub confirma que **pegou** a mensagem de
  uma pessoa (que nasce `pending`). Só o executor; confirmar de novo devolve a mesma resposta (a primeira hora vale).
  Mensagem inexistente, de outro assunto ou apagada: 404 `message-not-found`.
- `DELETE /hub/conversations/:id/messages/:messageId`: apaga (lápide) só as mensagens do próprio Hub (as de pessoas:
  403 `not-conversation-owner`); 204, idempotente.

**Anexos** (áudio, imagem, documento; mesmo fluxo do backup, §9, com índice próprio): o blob é cifrado com a chave do
assunto (`docs/crypto/conversations.md`, rótulo `conversation-attachment`, `recordId` = id do anexo, UUID v7 gerado
no Hub), até **100 MiB** cifrados.

- `POST /hub/conversations/:id/attachments` `{ id, keyVersion, sizeBytes, sha256 }` (sha256 do blob cifrado, hex
  minúsculo): reserva o tamanho no espaço e devolve `{ attachment, upload: { url, headers, expiresAt } }`. Faça o
  `PUT` na `url` com os bytes exatos e os `headers` **sem mudar nada** (a assinatura cobre tamanho, checksum e a tag
  `stage=upload`); a URL vale 15 min e a reserva 24 h. 201; o mesmo pedido de novo devolve 200 com uma URL nova (ou
  `upload: null` se já foi confirmado); o mesmo `id` com outro conteúdo: 409 `attachment-id-conflict`. Erros: 422
  `attachment-too-large` (> 100 MiB), 409 `conversation-key-rotation-required` / `conversation-key-version-stale`,
  422 `space-storage-full` (`missingBytes`; anexos, mensagens e backup dividem o tamanho do espaço), 409 `storage-busy`
  (repetir).
- `POST /hub/conversations/:id/attachments/:attachmentId/confirm`: depois do PUT; o backend confere tamanho e sha256
  (422 `upload-mismatch` se não bater ou se o PUT não foi feito) e copia no S3. Só quem pediu confirma (outro: 404
  `attachment-not-found`, também depois de 24 h). Idempotente: confirmar de novo devolve a mesma resposta. 409
  `storage-busy`: repetir.
- `POST /hub/conversations/:id/attachments/:attachmentId/download`: `{ url, expiresAt }` (GET assinado, 15 min) de um
  anexo confirmado; pendente, apagado ou de outro assunto: 404 `attachment-not-found`. Abra com `openAttachment`.
- `DELETE /hub/conversations/:id/attachments/:attachmentId`: apaga (lápide) só os anexos que o próprio Hub enviou (os
  de pessoas: 403 `not-conversation-owner`); 204, idempotente; inexistente ou de outro assunto: 404
  `attachment-not-found`. O backend não sabe quais anexos uma mensagem cita (a referência está no corpo cifrado): ao
  apagar uma mensagem, apague também os anexos dela. O apagado fica 30 dias na lixeira (conta no uso do espaço) e
  depois a retenção tira o conteúdo; o dono do assunto pode esvaziar antes, pelo app.

### A nuvem como executor de reserva (contrato com o Hub)

Num espaço em **nuvem ativa** todo assunto nasce com a nuvem como executor de **reserva** (`cloudReserve: true`; spec
active-cloud §4.3). O Hub continua sendo o executor principal; a nuvem só cobre quando ele está fora de alcance.

1. **Hub primeiro, 30 s.** Uma mensagem de pessoa `pending` é do Hub durante **30 s** contados do `sentAt` dela
   (`CLOUD_FALLBACK_AFTER_MS = 30_000`). Um Hub ligado acompanha o feed com sondagem longa e confirma em segundos; se
   não confirmar em 30 s, a nuvem tenta pegá-la. **O `ack` decide quem pegou, nunca os dois:** o Hub e a nuvem travam o
   assunto do mesmo jeito e o primeiro ack vale. Uma mensagem que **voltou à fila** (o executor que a confirmou deixou de
   ser executor; um Hub novo foi escolhido) ganha **30 s novos** a partir dessa volta, para o Hub novo pegá-la.
2. **A nuvem não espera** (pega na hora) quando a pessoa pede **"responder pela nuvem"**: na mensagem
   (`cloudAnswerRequested: true` no item `conversation_message`) ou no assunto inteiro (`cloudAnswer: true` no item
   `conversation`), e quando o assunto não tem Hub executor. **O Hub deve deixar essas mensagens para a nuvem** (não
   confirmar uma mensagem `pending` com `cloudAnswerRequested` nem as de um assunto com `cloudAnswer`, enquanto
   `cloudReserve` estiver ligada). Se confirmar mesmo assim, o primeiro ack continua valendo (nunca duas respostas).
3. **Mensagem confirmada pela nuvem não é executada pelo Hub.** O ack do Hub dá 404 `message-not-found` (descarte) e o
   feed mostra `pending: false`, `ackedByCloud: true`. Vale também quando o Hub volta **no meio** da resposta da nuvem:
   ela já é da nuvem; a resposta chega depois como `authorCloud: true`. Se a reserva cair antes da resposta, a mensagem
   volta a `pending` e é do Hub (a nuvem confere, sob a trava do assunto, que a mensagem ainda é dela antes de gravar a
   resposta; senão não grava nada). **A nuvem também devolve** o que pegou e não conseguiu responder depois de esgotar
   as tentativas (embeddings ou modelo fora do ar): a mensagem volta a `pending` com `requeuedAt` novo, o Hub ganha de
   novo os 30 s e o ack dele volta a valer (200); a nuvem só olha o assunto de novo uns 10 min depois. Para o Hub é o
   mesmo caso de uma mensagem devolvida à fila por troca de executor: `pending` no feed = trabalho dele.
4. **Ordem:** a nuvem responde as mensagens de um assunto **em ordem**, uma de cada vez (só pega a próxima depois de
   responder a anterior); o id da resposta é derivado do id da pergunta (uma resposta por pergunta, mesmo com
   repetição).
5. **Orçamento de IA esgotado:** a nuvem **não pega** a mensagem (ela continua `pending`, é do Hub) e manda **um** aviso
   fixo por fila de pendentes (`notice: "ai-budget-exceeded"` no texto em claro). O Hub segue normal.
6. **Texto em claro** das mensagens (todos os executores): a convenção v1 de `docs/crypto/conversations.md` ("Texto em
   claro das mensagens"): `{"text": "..."}` e campos opcionais; texto puro também vale.
7. **Regra de confidencialidade (vale para o Hub também):** antes de gravar um documento no espaço (decisão, convenção,
   ata, planejamento), o executor **propõe e pergunta** (mensagem com `documentProposal`) e só grava depois que a
   pessoa confirma na mensagem **seguinte** (texto ou `documentDecision: { decision: "record" }`). Se o conteúdo
   parecer confidencial e o espaço for amplo, avisa **quem lê o espaço** (quantas pessoas e papéis; o Hub tem isso pela
   sincronização) e oferece: gravar mesmo assim, gravar num espaço mais restrito, não gravar. **Nunca grava em
   silêncio.** Depois de gravar, a resposta traz `documentRecorded: { fileId, title }`.
8. **Documentos gravados pela nuvem** vão para o backup do espaço e para o **manifesto da nuvem**; o Hub os
   **incorpora** ao próprio manifesto (mesmo `fileId` e mesmos `objectId`s, sem reenviar bytes) e o servidor tira a
   entrada do manifesto da nuvem na gravação seguinte: `docs/hubs/space-manifest.md`, "Manifesto da nuvem e incorporação
   pelo Hub".

**Assunto movido de espaço** (pelo dono, no app): o assunto antigo ganha lápide (chega no feed como `conversation` com
`deleted: true`: apague-o localmente) e o novo, criado no destino com `movedFromConversationId`, só chega a este Hub se
ele for escolhido de novo como executor (entrada no escopo: busque com `conversationId=<id>&since=0`).

O Hub **deixa de ser executor** (404 `conversation-not-found` dali em diante, cópias dele com lápide) quando é
desregistrado, a organização é desvinculada, o espaço sai dele ou o dono dele deixa de participar do assunto. As
mensagens pendentes ficam esperando o executor novo.

## Nuvem ativa: o que muda para o Hub

Resumo para quem implementa o Hub (spec `docs/superpowers/specs/2026-11-10-active-cloud-design.md`). Um espaço em
**nuvem ativa** (`cloudMode = "active_cloud"` no item `space` do `GET /hub/sync`) é lido pelo servidor: a nuvem indexa
o backup cifrado e responde nos assuntos quando o Hub está fora de alcance. Fora da nuvem ativa nada disto vale (o
servidor não lê nada).

1. **Manifesto do espaço** (em **todo** espaço, com ou sem nuvem): o Hub mantém o manifesto do Hub (objeto do backup com
   `objectId` fixo derivado do espaço) listando **só documentos** (arquivos e, na nuvem ativa, espelhos de conector),
   nunca assuntos, eventos, pedaços do índice ou estado interno. Formato, limites e vetor de teste em
   `docs/hubs/space-manifest.md`.
2. **Espelhos de conector** entram no backup **só** nos espaços em nuvem ativa; quando o espaço sai dela, o Hub para de
   enviá-los e os apaga do backup (`space-manifest.md`, "Espelhos de conector no backup").
3. **Manifesto da nuvem:** os documentos gravados pela nuvem ficam no manifesto da nuvem (escrito só pelo servidor); o
   Hub os **incorpora** ao manifesto dele (mesmo `fileId`, mesmos `objectId`s, sem reenviar bytes) a cada passada do
   backup (`space-manifest.md`, "Manifesto da nuvem e incorporação pelo Hub").
4. **Executor de reserva nos assuntos:** Hub primeiro (30 s a partir do `sentAt` ou da volta à fila), o ack decide quem
   pegou, mensagem confirmada pela nuvem nunca é executada pelo Hub, mensagens com "responder pela nuvem" ficam para a
   nuvem (seção "A nuvem como executor de reserva", acima).
5. **Cópia para o servidor nos assuntos:** criar assunto num espaço em nuvem ativa e trocar a chave de um assunto com
   `cloudReserve: true` levam `serverWrappedKey`, selada para `GET /hub/cloud/server-key`.
6. **Regra de confidencialidade** antes de gravar documento (propor, perguntar, nunca gravar em silêncio) e o **texto em
   claro das mensagens** na convenção v1 de `docs/crypto/conversations.md`: valem para o Hub também.
7. **Embeddings:** mesmo modelo (`nomic-embed-text`), sem prefixo de tarefa, mesma divisão em trechos (`space-manifest.md`,
   "Trechos e embeddings"); mudar isso é mudança conjunta com reindexação dos dois lados.

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
| `POST /hub/user-sessions` | 10/min e 5/min | Hub e e-mail |
| `GET /hub/sync` | 120/h | Hub |
| `POST /hub/spaces/:spaceId/uploads` | 600/h | Hub |
| `POST /hub/spaces/:spaceId/uploads/confirm` | 600/h | Hub |
| `POST /hub/spaces/:spaceId/objects/delete` | 120/h | Hub |
| `GET /hub/spaces/:spaceId/objects` | 1200/h | Hub |
| `POST /hub/spaces/:spaceId/objects/:objectId/versions/:versionId/download` | 12 mil/h | Hub |
| `POST /hub/conversations` | 120/h | Hub |
| `PUT /hub/conversations/:id/state` | 600/h | Hub |
| `POST /hub/conversations/:id/keys` | 30/h | Hub |
| `POST /hub/conversations/:id/messages` e `DELETE .../messages/:messageId` | 300/min (cada rota) | Hub |
| `POST /hub/conversations/:id/messages/:messageId/ack` | 600/min | Hub |
| `POST /hub/conversations/:id/attachments` e `.../attachments/:attachmentId/confirm` | 600/h (cada rota) | Hub |
| `GET /hub/conversations/changes` (feed do executor, sondagem longa) | 1800/h | Hub |
| `GET /hub/cloud/server-key` (pública do servidor, nuvem de reserva) | 300/min somando as demais | IP |
| demais rotas | 300/min somando todas | IP |

Estourou: 429 `too-many-requests` com `Retry-After` (segundos).

## Pendências que afetam o Hub

- **WebSocket Hub ↔ backend:** hoje o Hub só puxa (status e sincronização por HTTP). Notificações em tempo real e
  comandos para o aparelho entram com o canal WebSocket.
- **Apagamento remoto:** não há comando para o backend mandar o Hub se apagar. O desregistro só corta o acesso.
- **Transferência de Hub:** não existe. Hoje o caminho é desregistrar e fazer reset de fábrica.
- **Ordem de commit × `sync_version`:** uma sincronização pode pular de vez uma linha cujo commit chegou atrasado.
  Até a correção (versões dadas no COMMIT, como nos assuntos), a sincronização completa periódica corrige o estado. O
  feed dos assuntos (`GET /hub/conversations/changes`) já tem versões na ordem dos commits e não precisa disso.
- **Nuvem ativa:** prefixos de tarefa nos embeddings (`search_document:`/`search_query:`) só como mudança conjunta com
  reindexação dos dois lados; executor na nuvem completo e Hub hospedado ficam para depois (hoje a nuvem é só reserva).
- **Backup (storage):** snapshot pago, troca de chave feita pelo Hub editor da Sala (hoje o Hub guarda os envios numa
  fila local até um membro trocar a chave pelo app), visitante em Hub alheio, configuração inicial por Bluetooth e
  idioma, download em lote, endpoint S3 público para aparelhos em desenvolvimento (a URL assinada hoje aponta para o
  host interno do Docker). Lista completa em `CLAUDE.md`, "Pendências antes de produção".
