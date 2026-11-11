# O que o app precisa fazer (levantado pelo backend)

Lista do que o app (`vaulter-hub-app`) precisa implementar para usar o que o backend já entrega. Decidido em
09/11/2026: o app é prototipado **depois** que o backend estiver fechado; até lá, esta lista junta os pedidos que
surgiram em cada módulo. As regras completas e os campos estão no `CLAUDE.md` deste repositório e nos documentos
citados; aqui fica só o que o app faz e onde ler.

Ao implementar um item, marque aqui e confira o contrato na fonte (os nomes de campo e rotas valem o que está no
código e no `CLAUDE.md`).

## Conta e cadastro
- [ ] **Código de recuperação obrigatório no cadastro:** gerar os 32 bytes, mostrar à pessoa (forma de exibição é do
  app), confirmar que ela guardou e enviar a prova e a cópia trancada. Fonte: `docs/crypto/user-keys.md` (seção do
  código de recuperação).
- [ ] **Recuperar a conta** com e-mail + código (dois passos) e sugerir gerar um código novo logo depois.
- [ ] **Trocar o código** em Configurações (pede a senha atual).
- [ ] Na suspeita de comprometimento: trocar a senha **e** gerar código novo, **um depois do outro**, nunca em paralelo.

## Organização e kit de recuperação
- [ ] Antes de trocar o kit da organização, conferir espaços órfãos com versões no kit atual
  (`GET /organizations/:orgId/spaces?all=true`, `memberCount`, `recoveryRewrapRequired`) e reabrir antes.
- [ ] **Aviso de nomeação pela plataforma:** enquanto `platformAppointment` vier em `GET /organizations/:id`, avisar
  **todos os membros** que um admin foi nomeado pelo suporte Vaulter (e até quando vale a proteção de 7 dias).
- [ ] **Antes de retrancar para um kit novo:** mostrar quem trocou o kit e quando (`recoveryKeyChangedAt`,
  `recoveryKeyChangedByUserId`) e pedir confirmação. Data vazia com kit cadastrado = desconhecido, não "nunca trocado".

## Espaços e chaves
- [ ] **Troca de chave pendente** (`keyRotationRequired`): avisar os membros com insistência. Enquanto ninguém troca,
  o Hub não consegue enviar backup daquele espaço (fica numa fila local).
- [ ] Descobrir os Hubs da Sala para a troca de chave (`roomHubs` em `GET /spaces/:id` + chave de cifra em
  `GET /hubs/:id`).
- [ ] **Nuvem ativa: troca de chave** num espaço com `cloud.mode = 'active_cloud'` (`GET /spaces/:id`): selar a versão
  nova também para `GET /cloud/server-key` e mandar em `serverWrappedKey` (sem ela, 409 `key-rotation-mismatch` com
  `missingServer: true`).

## Nuvem ativa
- [ ] **Aviso permanente** em todo espaço com `cloud.mode = 'active_cloud'` (`GET /spaces/:id` -> `cloud`): o Vaulter lê
  aquele espaço, desde `activatedAt`.
- [ ] **Termo de aceite** (quem decide: admin com `org.members.manage`; na pessoal, a própria pessoa):
  `GET /organizations/:orgId/cloud/terms` -> mostrar `current.text`; aceitar com
  `POST .../cloud/terms/accept` `{ version, hash }` (os do termo mostrado; 422 `cloud-terms-outdated` = recarregar e
  mostrar de novo). Termo novo (`accepted.version < current.version`) precisa de aceite antes de ligar outro espaço.
- [ ] **Ligar em dois passos:** quem decide autoriza (`POST /spaces/:spaceId/cloud/authorize`, mesmo fora do espaço); o
  Gestor vê `GET /spaces/:spaceId/cloud` -> `state: 'authorized'` e liga com `POST .../cloud/activate`
  `{ serverGrants }` (todas as versões da chave seladas para `GET /cloud/server-key`). Na pessoal, os dois passos seguidos
  pela mesma pessoa. Espaço órfão não liga (422 `space-orphaned`).
- [ ] **Desligar** (`POST /spaces/:spaceId/cloud/deactivate`, quem decide ou o Gestor): explicar antes que apaga do
  servidor a cópia da chave e todo o conteúdo legível (o backup cifrado fica).

## Backup e espaço ocupado
- [ ] **Espaço quase cheio:** com `storage.usedBytes` acima de **80%** de `storage.quotaBytes` e a lixeira
  (`storage.trashBytes`) sendo parte relevante disso, avisar o Gestor e oferecer **esvaziar a lixeira** ou
  **aumentar o espaço**. Percentuais ficam no app.
- [ ] **Backup parado:** quando um envio for recusado por espaço cheio, avisar que o backup do espaço parou.
- [ ] **Esvaziar a lixeira:** repetir enquanto `remainingVersions > 0`; parar se um pedido não apagar nada. Lixeira
  muito grande leva várias rodadas (limite de reautenticação: até 5000 versões por 15 min); explicar isso à pessoa.
- [ ] Mostrar tamanho reservado, usado e lixeira do espaço; franquia e reservado da organização; capacidade e
  reservado do Hub (o app calcula o "livre").

## Hub
- [ ] Tela pós-login com os caminhos: **configurar Hub novo**, **entrar num Hub existente** (código de vínculo),
  **trocar de Hub / restaurar** (reinstalar os espaços no Hub novo).
- [ ] Instalar/desinstalar espaços no Hub como um console, mostrando o que cabe no SSD (erro `hub-storage-full`).

## Assuntos (conversas)
Visão geral: o assunto é dado do espaço, cifrado **no celular** com uma chave própria por versão (formato em
`docs/crypto/conversations.md`; o backend só guarda blobs). O que o app precisa cobrir:
- [ ] **Cifra no celular:** gerar a chave do assunto (versão 1), trancá-la para cada participante e para o Hub executor
  (`wrappedKey`, 108 caracteres), cifrar cabeçalho (título, plano), mensagens (≤ 64 KiB cifrados; maior vira anexo) e
  anexos (≤ 100 MiB cifrados) com os rótulos e o `recordId` do formato; ids UUID v7 gerados no aparelho (reenviar o
  mesmo id é seguro). Nunca mandar nome ou tipo de arquivo em claro.
- [ ] **Compartilhar** (`POST .../:id/participants` e `/participants/space`): mandar a cópia de **todas** as versões da
  chave para cada pessoa nova (até 50 participantes vivos); quem não é membro do espaço dá 422
  `participant-not-space-member`. **Limite do corpo (100 kB):** cada cópia ocupa ~140 bytes no JSON, então "compartilhar
  com o espaço" (`/participants/space`, que exige **todas** as pessoas que faltam num pedido só) passa do limite por
  volta de **12 versões × 50 pessoas** (413). Antes de mandar, estimar o tamanho (pessoas × versões × ~140 bytes); se
  passar de ~90 kB, usar o modo `people` (`/participants`) em **lotes** (cada lote é idempotente: quem já participa é
  pulado). **Sair/tirar:** `POST .../:id/leave`, `DELETE .../:id/participants/:userId`.
- [ ] **Editar o título/plano (cabeçalho):** só o dono, `PUT /spaces/:spaceId/conversations/:id/header`
  `{ keyVersion, encryptedHeader }`, cifrado com a versão **atual** da chave (409 `conversation-key-version-stale` /
  `conversation-key-rotation-required`: atualizar ou trocar a chave antes). O cabeçalho conta no uso do espaço (422
  `space-storage-full`, também ao criar um assunto).
- [ ] **Executor:** escolher entre os Hubs do dono com o espaço instalado (`PUT .../:id/executor`; trocar manda as
  cópias de todas as versões ao Hub novo e deixa a troca de chave pendente); mensagem de pessoa nasce `pending` até o
  Hub confirmar (mostrar "entregue ao Hub" quando `ackedAt` vier).
- [ ] **Aviso de troca de chave do assunto:** quando `keyRotationRequired` for `true` (alguém saiu, ou o executor
  mudou), mensagens e anexos novos dão 409 `conversation-key-rotation-required`: mostrar o aviso e fazer a troca
  (`POST .../:id/keys`: versão atual + 1 para **exatamente** os participantes vivos e o Hub; 409
  `key-rotation-mismatch` traz os ids faltando/sobrando). Com a flag, qualquer participante ou o executor troca; sem
  ela, só o dono (409 `key-rotation-not-required`). Versão velha: 409 `conversation-key-version-stale` (atualizar pelo
  feed e reenviar).
- [ ] **Sincronizar** por `GET /conversations/changes?since=&limit=` (um cursor para todas as organizações; resposta
  `{ organizationIds, items, nextSince }`, padrão do `GET /hub/sync`): assuntos em que a pessoa participa, participações,
  as cópias da chave **dela**, mensagens (corpo cifrado) e anexos (metadado). Contrato no comentário de
  `SyncConversationsUseCase` e no `CLAUDE.md` (módulo `conversations`). O que o app faz:
  - lápide da **própria** participação (ou do `conversation`) = apagar o assunto localmente (mensagens, anexos, chaves);
  - organização fora de `organizationIds` = apagar os assuntos dela;
  - assunto vivo que o app não tinha (alguém compartilhou com a pessoa) = buscar o histórico com
    `conversationId=<id>&since=0` e seguir com o cursor principal;
  - mensagem com `replacesMessageId` = edição (esconder a substituída);
  - **itens filhos de um assunto desconhecido** (mensagem, anexo, participação, cópia da chave) **podem chegar antes do
    item `conversation`** (a ordem é só por `sync_version`): guardar e aplicar quando o assunto chegar, nunca descartar;
  - não precisa de sincronização completa periódica: as versões são dadas no COMMIT, na ordem dos commits (nunca pula
    uma mudança que confirmou atrasada, e o que confirmou já sai na próxima leitura).
  Sem sondagem longa para o app (só o Hub executor tem); com o app aberto, uma passada a cada ~10 s cabe no limite
  (1200/h por pessoa).
- [ ] **Mover para outro espaço** (só o dono; spec §4.2): (1) criar o assunto no destino com
  `POST /spaces/:destino/conversations` + `movedFrom: { spaceId, conversationId }` (chave NOVA, cabeçalho cifrado de
  novo; o executor é escolhido de novo, entre os Hubs do dono com o destino instalado, ou nenhum); (2) reenviar as
  mensagens (ids NOVOS, cifradas com a chave nova) e os anexos (intenção, PUT, confirmação); (3) compartilhar só com
  quem é membro do destino (os outros dão 422 `participant-not-space-member` e ficam de fora: avise o dono antes);
  (4) `POST /spaces/:origem/conversations/:antigo/move` `{ toSpaceId, toConversationId }` põe a lápide no antigo
  (idempotente). Erros: 403 `not-conversation-owner`, 422 `conversation-move-invalid` (mesmo espaço, ou o novo não foi
  criado com `movedFrom` = antigo). Se o passo 2 falhar no meio, repita antes do 4 (criar com o mesmo `id` devolve 200).
- [ ] **Apagar anexo**: `DELETE /spaces/:spaceId/conversations/:id/attachments/:attachmentId` (só quem enviou; 204,
  idempotente). Ao apagar uma mensagem, apague também os anexos que ela cita (o backend não sabe quais).
- [ ] **Esvaziar a lixeira do assunto** (só o dono, com reautenticação, como a do espaço):
  `POST /spaces/:spaceId/conversations/:id/trash/empty` `{ currentAuthProof }` -> `{ purgedMessages,
  purgedAttachments, purgedBytes, remainingAttachments }`; repetir enquanto `remainingAttachments > 0` (cada volta gasta
  o orçamento de reautenticação, 5 por 15 min). Sem esvaziar, a retenção tira o conteúdo apagado depois de 30 dias.
- [ ] **Lixeira do espaço × assuntos:** `storage.trashBytes` de `GET /spaces/:id` **inclui** a lixeira dos assuntos
  (mensagens e anexos apagados nos últimos 30 dias), que o esvaziar do Gestor **não** alcança (só o dono de cada
  assunto, rota acima, ou a retenção em 30 dias). Ao avisar o Gestor de lixeira cheia, dizer que parte pode ser de
  assuntos privados e que ela some sozinha em até 30 dias. (Decisão da Task 7: documentar em vez de separar o número.)

## Ideias para depois (não fazer agora)
- Configuração inicial do Hub pelo app via **Bluetooth** (no lugar do código falado; resolve o idioma).
- Visitante em Hub alheio.
