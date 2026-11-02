# Módulo `hubs` — design

Data: 01/11/2026 · Status: **aprovada em 01/11/2026 (implementada)** · Repositório: `vaulter_back`

Nasce de uma conversa do Jonas com o Claude. Parte da spec de produto
`../valter-valt-ai/docs/superpowers/specs/2026-10-24-organizacoes-espacos-e-nuvem-design.md` (§3, §4, §4.1, §5,
§5.0, §5.1, §7.2), do roadmap do Hub (`../vaulter-hub-back/docs/roadmap-ecossistema.md`, Camada 0), do DER
`docs/der_model.sql` (`hubs`, `hub_organization`, `hub_space`, `role_assignments`, `space_key_grants`) e dos módulos
`identity`, `organizations` e `spaces` (padrões no `CLAUDE.md`). Onde está escrito *"decisão do Claude"*, o Jonas
não decidiu explicitamente.

## 1. Intenção

O Hub é o aparelho do cliente, usado como um **console de videogame**: várias pessoas fazem login nele, e ele
atende uma pessoa sozinha, um time ou uma empresa. O aparelho tem um **dono** (um usuário) e não pertence a
nenhuma organização: **atende** várias. Os dados são da organização, e o aparelho é do dono, por isso o vínculo
pede **dois consentimentos**.

Este módulo dá ao backend o que ele precisa para isso:
- registrar o aparelho com uma identidade criptográfica;
- ligar o aparelho a um dono;
- vincular organizações e espaços;
- liberar espaços na "Sala";
- entregar ao Hub, por sincronização, o que ele precisa para funcionar inclusive offline.

## 2. Objetivos, não objetivos e anti-objetivos

**Objetivos**
- **Apresentação:** o Hub se apresenta com as próprias chaves e recebe um código de reivindicação, que fala em
  voz alta. O dono reivindica pelo app.
- **Autenticação do Hub** no backend, sem senha: desafio assinado com a chave Ed25519 do aparelho.
- **Vínculo Hub ↔ organização** com dois consentimentos: o dono escolhe, e a organização aprova conforme a
  política. Inclui o **pedido** de outro usuário para trazer a organização dele.
- **Espaços no Hub** (`hub_space`) e **espaços liberados na Sala**: papel da Sala no espaço mais a cópia da chave
  trancada para o Hub.
- **Papéis de Hub** (Dono, Operador, Usuário, Sala) do catálogo de fábrica.
- **Sincronização por HTTP:** o Hub baixa, por `sync_version` e com lápides, o material para funcionar e fazer
  login offline (§5.0).
- **Desregistrar** um Hub.

**Não objetivos (ficam para depois)**
- Hotspot ou Wi-Fi de configuração (Hub e app).
- Canal em tempo real Hub ↔ backend (WebSocket com JSON versionado; módulo seguinte).
- Upload e backup do cérebro (storage); nuvem ativa.
- Apagamento remoto de aparelho perdido ou roubado; transferir o Hub para outro dono.
- Pareamento por QR (adiado no roadmap do Hub).

**Anti-objetivos (se acontecer, falhou mesmo funcionando)**
- Dados de uma organização num Hub que ela não autorizou: sem os dois consentimentos, ou depois de desvincular.
- Um Hub ler um espaço que não foi liberado na Sala dele sem uma pessoa autorizada logada.
- O backend, ou alguém com acesso ao banco, se passar por um Hub (precisaria da chave privada do aparelho).
- Um Hub, ou quem tem o token dele, ver dados de organizações que ele não atende.
- O caso simples (uma pessoa, um Hub, a organização pessoal) ganhar passos a mais.

## 3. Decisões do Jonas

- O passo a passo do §4 deste documento, aprovado em 01/11/2026.
- Da spec de produto:
  - Hub com dono que atende várias organizações;
  - dois consentimentos com política `any_member_hub` (padrão) ou `admin_approved`;
  - pedido de outro usuário;
  - Sala como papel;
  - espaços liberados na Sala só por decisão do dono, se a política da organização permitir;
  - login offline até 30 dias com o material trancado dos membros;
  - desvincular apaga a cópia local na próxima sincronização.

## 4. Fluxo

1. **Primeiro boot (Hub):** o aparelho gera um par **Ed25519** (identidade) e um par **X25519** (cifra). Ficam no
   SSD com LUKS e nunca saem dele.
2. **Apresentação:**
   - o Hub chama `POST /hub-enrollments` com `{ signingPublicKey, encryptionPublicKey, nonce, signature }`. A
     assinatura Ed25519 cobre um rótulo fixo sem o nome do produto, as duas chaves e o `nonce`;
   - o backend confere a assinatura e cria uma **apresentação pendente**, com o código de reivindicação guardado
     só como hash;
   - devolve `{ enrollmentId, claimCode, expiresAt }`. O código tem **8 dígitos** (fácil de falar e digitar) e
     vale **10 min** (decisão do Claude).
3. **Reivindicação (app):**
   - o dono, logado, chama `POST /hubs/claim` com `{ claimCode, name }`;
   - o backend cria o Hub (`hubs`, dono = usuário, chaves da apresentação), dá ao dono o papel `hub_owner` no
     escopo do Hub e à Sala o papel `hub_room`, e consome a apresentação;
   - **vínculo automático:** na mesma transação, a **organização pessoal do dono** já fica vinculada e aprovada
     (decisão do Claude, para o caso simples não ganhar passos);
   - **espaços no Hub e Sala:** pôr os espaços no Hub e liberar na Sala continua sendo feito pelo app logo
     depois, numa sequência de chamadas, porque a Sala exige que o app tranque a chave;
   - código inválido ou vencido devolve o erro único `claim-code-invalid`, com rate limit forte.
   - **Chave do aparelho é de um Hub só:** a `signing_public_key` é **única para sempre**, inclusive entre Hubs
     desregistrados. Um aparelho desregistrado precisa de **reset de fábrica** (apagar o SSD e gerar chaves novas)
     antes de ser reivindicado de novo, por esse dono ou por outro. Assim nada do dono anterior chega a um dono
     novo (decisão do Claude).
4. **Hub descobre que foi reivindicado:** o Hub consulta `GET /hub-enrollments/:id/status` com uma assinatura
   recente. Quando já há Hub criado, a resposta é `{ hubId }` e ele passa a se autenticar.
5. **Autenticação do Hub:**
   - `POST /hub-auth/challenge { hubId }` devolve um desafio de uso único com validade curta;
   - `POST /hub-auth/token { hubId, challenge, signature }` devolve um **token de acesso de Hub**: JWT EdDSA com o
     mesmo emissor e chaves do `identity`, mas `typ: 'hub+jwt'` e `sub = hubId`, válido por 15 min;
   - não há refresh: o Hub repete o desafio;
   - Hub desregistrado é recusado;
   - `last_seen_at` é atualizado.
6. **Vincular organizações** (dois consentimentos):
   - **Dono pede:** o dono chama `POST /hubs/:id/organizations { organizationId }` para uma organização da qual é
     membro, e o consentimento do dono já fica dado;
   - **Organização aprova:** com `any_member_hub`, o vínculo nasce **aprovado**. Com `admin_approved`, fica
     **pendente** até um admin (`org.hubs.approve`) aprovar ou recusar;
   - **Outro usuário pede:** quem não é dono (um membro da organização que usa o Hub) cria um **pedido**. O dono
     precisa aprovar e, se a política exigir, também um admin.
     - **Como ele chega ao Hub sem enxergá-lo (decisão do Claude):** o Hub pede ao backend um **código de vínculo**
       (`POST /hub/link-codes`, com token de Hub): 8 dígitos, vale 10 min, uso único, só hash no banco. O Hub mostra
       ou fala o código.
     - A pessoa, no app dela, chama `POST /hubs/link-requests { linkCode, organizationId }` para uma organização
       da qual é membro.
     - Isso prova que ela está diante do aparelho, não expõe o `hubId` e impede pedidos em massa. Código inválido
       dá `link-code-invalid`, com rate limit por usuário.
   - **Vínculo ativo:** só quando os dois consentimentos necessários existem;
   - **Desvincular:** dono ou admin da organização desvinculam a qualquer momento. Desvincular apaga os espaços da
     organização no Hub, a liberação na Sala e as cópias da chave para o Hub, e marca a troca de chave pendente
     nos espaços que estavam liberados na Sala.
7. **Espaços no Hub:**
   - **o que é `hub_space`:** os espaços cujo cérebro (documentos e RAG) **mora naquele Hub**. É onde o conteúdo
     existe, de onde sai o backup e o que o Hub sincroniza. Levar um espaço para outro Hub já existente é não
     objetivo da v1 (spec de produto §2);
   - **quem põe (decisão do Claude, no espírito de "console"):** o **dono do Hub**, se for membro do espaço, ou um
     **Gestor do espaço**, se for membro de uma organização vinculada e aprovada. A organização já consentiu com o
     Hub ao aprovar o vínculo. Assim os espaços da Ana também ficam usáveis no Hub, mesmo sem o dono participar
     deles;
   - **quem tira:** o dono do Hub tira qualquer espaço, porque o aparelho é dele; um Gestor tira o próprio espaço;
   - quem não está no espaço não o lê no Hub de qualquer forma, porque a chave só chega com o login de quem tem
     acesso.
8. **Liberar na Sala:**
   - quem faz: o dono, que precisa ser **Gestor** do espaço, porque tranca a chave para o Hub como faria para uma
     pessoa;
   - condições: o espaço já está no Hub e a organização **permite espaços na Sala**;
   - o que o app manda: a cópia de **todas as versões** da chave trancada para a `encryptionPublicKey` do Hub,
     junto com o papel da Sala no espaço (padrão Leitor);
   - tirar da Sala grava lápide no papel e nas cópias e marca a troca de chave pendente.
9. **Sincronização:**
   - o Hub chama `GET /hub/sync?since=<sync_version>&limit=` e recebe, em ordem de `sync_version` e com lápides:
     - as organizações vinculadas e o próprio Hub;
     - os membros dessas organizações com o material trancado (`publicKey`, `encryptedPrivateKey`, `kdfSalt`,
       `kdfParams`; **nunca** `authHash`), conforme o §5.0;
     - os papéis relevantes (organização, espaços do Hub e o próprio Hub);
     - os espaços no Hub e suas versões de chave;
     - as cópias da chave trancadas para o Hub;
     - as cópias trancadas para os membros nos espaços do Hub;
   - o Hub guarda o maior `sync_version` visto;
   - se ficou mais de 30 dias sem sincronizar, faz uma sincronização completa (`since=0`).
10. **Pessoas no Hub:**
    - online, a pessoa faz o login normal do `identity` com `device.platform = 'hub'`, sem rota nova;
    - offline, a senha abre a chave privada.

## 5. Modelo e mudanças no DER

- **`hubs`:**
  - `public_key` vira `encryption_public_key` (X25519);
  - entra `signing_public_key` (Ed25519), **única para sempre**, inclusive entre Hubs desregistrados, além de
    `owner_user_id` NOT NULL e `last_seen_at`;
  - é sincronizável e **não tem `organization_id`**, porque não pertence a nenhuma;
  - RLS (decisão do Claude): visível para o dono, para membros de organizações vinculadas e para o próprio Hub
    autenticado (`app.hub_id`).
- **`hub_link_codes`** (nova, não sincroniza): códigos de vínculo pedidos pelo Hub (`hub_id`, `code_hash`,
  `expires_at`, `used_at`), uso único, só hash.
- **`hub_enrollments`** (nova, não sincroniza):
  - colunas: `signing_public_key` (única entre pendentes), `encryption_public_key`, `claim_code_hash`,
    `expires_at`, `claimed_hub_id` e `status` (`pending` | `claimed` | `expired`);
  - fica fora do RLS de organização, porque ainda não pertence a ninguém. Só o caso de uso de reivindicação a
    acessa, pelo hash do código;
  - limpeza das expiradas por rotina, depois.
- **`hub_organization`:**
  - colunas que entram: `owner_approved_by_user_id`/`owner_approved_at` e `org_approved_by_user_id`/`org_approved_at`,
    porque o DER tem só um "aprovado por" e são dois consentimentos;
  - `status` (`pending` | `approved` | `rejected` | `revoked`), derivado dos dois;
  - `requested_by_user_id` continua;
  - leva `organization_id`, então RLS por organização mais leitura pelo dono do Hub e pelo próprio Hub;
  - é sincronizável;
  - FKs compostas onde houver filho de organização (padrão do `spaces`).
- **`hub_space`:**
  - leva `organization_id` desnormalizado, com FK composta para `spaces(id, organization_id)` e RLS por
    organização;
  - é sincronizável.
- **`organizations.allow_room_spaces`** (nova, boolean, padrão `true`, decisão do Claude): a "política da
  organização" que permite liberar espaços na Sala (spec §5.1). Admin muda no `PATCH /organizations/:id`.
- **`role_assignments`:**
  - **escopo Hub**: `scope_type = 'hub'`, `hub_id`, `organization_id` nulo (o Hub não é de organização) e papéis
    `hub_*`;
  - **Sala**: `room_hub_id` como "quem", com escopo espaço ou Hub;
  - as policies de RLS de `role_assignments` ganham esses casos;
  - CHECKs garantem "exatamente um quem" e "exatamente um onde".
- **`space_key_grants.hub_id`** (já existe, nulo): cópia trancada para o Hub, com FK composta e RLS pela
  organização do espaço.

## 6. Regras

- **Papéis de Hub:**
  - o dono tem `hub_owner`;
  - a Sala tem `hub_room` (`chat.voice`);
  - o dono pode atribuir `hub_operator` ou `hub_user` a membros de organizações vinculadas;
  - membro de organização vinculada sem atribuição explícita vale como `hub_user` (regra calculada na
    sincronização, sem linha; decisão do Claude).
- **Troca de chave (impacto no `spaces`):** a troca de chave passa a exigir uma cópia também para **cada Hub
  ativo com o espaço liberado na Sala**. O `key-rotation-mismatch` compara pessoas e Hubs.
  - **Gestor sem trocar a chave:** quem saiu do espaço pode ter guardado a chave, e quem tirou da Sala ou
    desvinculou também gera troca pendente.
  - **Limite:** `SPACE_MAX_MEMBERS` conta pessoas e Hubs juntos.
- **Desregistrar** (`DELETE /hubs/:id`, só o dono):
  - grava lápide no Hub, nos vínculos, nos `hub_space`, nas atribuições, na Sala e nas cópias para o Hub;
  - marca a troca pendente nos espaços que estavam liberados na Sala;
  - o token de Hub passa a ser recusado.
- **Dono sai da organização:** os vínculos dessa organização com os Hubs dele são revogados, via
  `MemberRemovedHooks`, como no `spaces`.
- **Dono perde o papel de Gestor:** a liberação na Sala **continua**. Ela é decisão de quem tinha o direito na
  hora, e um Gestor atual pode tirá-la. Decisão do Claude, revisável.
- **Saídas parciais (decisões do Claude):**
  - **Dono do Hub sai ou é tirado de um espaço:** a liberação na Sala desse espaço nos Hubs dele **cai**, com lápide
    nas cópias para o Hub e troca de chave pendente. O aparelho de quem não está mais no espaço não pode continuar
    com a chave. Um Gestor do espaço pode liberar de novo, se quiser. O `hub_space` continua, porque o conteúdo
    mora lá. O `spaces` avisa por um gancho novo de saída do espaço, e o `hubs` assina.
  - **Pessoa com `hub_operator` ou `hub_user` explícito sai da organização:** a atribuição de Hub vira lápide se ela
    não for mais membro de **nenhuma** organização vinculada àquele Hub (via `MemberRemovedHooks`).
  - **Desvincular uma organização:** pelo mesmo critério, viram lápide as atribuições de Hub de quem não tem mais
    nenhuma organização vinculada ao Hub.
- **Mudança de política vale só para a frente (decisão do Claude):**
  - **`hub_link_policy`:** passar a `admin_approved` não reabre vínculos já aprovados; vale para pedidos novos e
    pendentes;
  - **`allow_room_spaces`:** desligar bloqueia **novas** liberações na Sala. As existentes continuam até o dono ou
    um Gestor tirar.
  - Fica documentado e registrado como pendência: uma ação de admin para "tirar todas as liberações na Sala da
    organização", quando houver demanda.

## 7. API (rotas internas, sem a tag `public`)

| Método e rota | O que faz | Quem chama |
|---|---|---|
| `POST /hub-enrollments` | apresentação: chaves + assinatura → `{ enrollmentId, claimCode, expiresAt }` | Hub, público, com rate limit por IP |
| `GET /hub-enrollments/:id/status` | `pending`, ou `{ hubId }` quando reivindicado (assinatura recente nos cabeçalhos) | Hub, público, com rate limit |
| `POST /hubs/claim` | reivindica (`claimCode`, `name`) | usuário logado, com rate limit por usuário |
| `POST /hub-auth/challenge`, `POST /hub-auth/token` | desafio e token de Hub | Hub, público, com rate limit |
| `GET /hubs` | meus Hubs (dono) e Hubs das minhas organizações | usuário |
| `GET /hubs/:id`, `PATCH /hubs/:id` (nome), `DELETE /hubs/:id` | detalhes, renomear, desregistrar | dono (detalhes também membro de org vinculada) |
| `GET /hubs/:id/organizations` | vínculos e pedidos | dono, admin da org |
| `POST /hubs/:id/organizations` | dono vincula uma organização sua (`organizationId`) | dono |
| `POST /hub/link-codes` | Hub pede um código de vínculo (8 dígitos, 10 min) | Hub autenticado |
| `POST /hubs/link-requests` | outro usuário pede o vínculo da organização dele (`linkCode`, `organizationId`) | membro da org, com rate limit por usuário |
| `POST /hubs/:id/organizations/:orgId/approve` / `reject` | aprovação do dono ou do admin, conforme quem chama e o que falta | dono / `org.hubs.approve` |
| `DELETE /hubs/:id/organizations/:orgId` | desvincular | dono / admin da org |
| `GET /hubs/:id/spaces`, `POST /hubs/:id/spaces` (`spaceId`), `DELETE /hubs/:id/spaces/:spaceId` | espaços no Hub | pôr: dono (membro do espaço) ou Gestor do espaço de org vinculada; tirar: dono ou Gestor do espaço |
| `PUT /hubs/:id/spaces/:spaceId/room` | libera na Sala (`roleKey`, `recoveryPublicKey`, `grants: [{ version, wrappedKey }]` para o Hub) | dono Gestor do espaço |
| `DELETE /hubs/:id/spaces/:spaceId/room` | tira da Sala | dono / Gestor do espaço |
| `PUT /hubs/:id/roles/:userId` / `DELETE` | papel de Hub de um membro (`hub_operator` / `hub_user`) | dono |
| `GET /hub/sync` | sincronização do Hub | Hub autenticado |

- **Hub inexistente:** quem não pode ver o Hub recebe **404**.
- **Ação sem permissão:** em Hub que a pessoa vê, responde **403**.
- **Rotas de Hub autenticado:** ficam sob um prefixo próprio (`/hub/...`) e aceitam **só** token de Hub. As de
  usuário recusam token de Hub e vice-versa: o guard confere o `typ`.

## 8. Restrições técnicas

- **Padrões do `CLAUDE.md`:**
  - unit of work em toda mutação;
  - `OrganizationAccess`, `SpaceAccess` e um `HubAccess` novo (exportado);
  - RLS sem `SECURITY DEFINER`, testado pelo papel de runtime;
  - FKs compostas com organização onde houver filho;
  - migrations novas, `schema:check` vazio, `problem+json`, cursor, `camelCase`.
- **Assinaturas Ed25519 do Hub:**
  - formato documentado em `docs/crypto/` (rótulo de domínio, campos e ordem, base64url);
  - **rótulos sem o nome do produto**;
  - desafios e `nonce` de uso único e validade curta, contra replay.
- **Token de Hub:**
  - mesmas chaves e rotação por `kid` do `identity`;
  - `typ` distinto;
  - a verificação confere que o Hub existe e não foi desregistrado a cada requisição, como a sessão de usuário.
- **Sincronização:**
  - paginada por `sync_version`, com lápides (`withDeleted`);
  - nunca envia `authHash` nem segredos;
  - só dados das organizações vinculadas e aprovadas;
  - um Hub não vê nada de organização que ele não atende, garantido pelo caso de uso e pelo RLS com `app.hub_id`.
- **Rate limit:**
  - apresentação, consulta de status e autenticação de Hub, por IP;
  - reivindicação, por usuário (mais forte, contra adivinhar o código de 8 dígitos);
  - sincronização, por Hub.
- **Auditoria:** `hub.claimed`, `hub.deregistered`, `hub.organization.requested`, `hub.organization.approved`,
  `hub.organization.rejected`, `hub.organization.revoked`, `hub.space.added`, `hub.space.removed`,
  `hub.room.granted`, `hub.room.revoked` e `hub.role.changed`, na organização correspondente quando houver uma.
- **DER:** as mudanças entram no `.sql` e no `.mwb`.

## 9. Fica a cargo de quem construir

- O formato exato das mensagens assinadas e da assinatura de status (respeitando o §8).
- O desenho do payload de sincronização (entidades e campos) e o tamanho de página.
- Os números de rate limit e as validades exatas do desafio e do `nonce`.
- O desenho das policies de RLS de `hubs` e das atribuições de Hub e de Sala.
- A ordem das tarefas e como fatiar os commits.
