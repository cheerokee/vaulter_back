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
- [ ] **Sincronizar** por `GET /conversations/changes?since=&limit=` (um cursor para todas as organizações; resposta
  `{ organizationIds, items, nextSince }`, padrão do `GET /hub/sync`): assuntos em que a pessoa participa, participações,
  as cópias da chave **dela**, mensagens (corpo cifrado) e anexos (metadado). Contrato no comentário de
  `SyncConversationsUseCase` e no `CLAUDE.md` (módulo `conversations`). O que o app faz:
  - lápide da **própria** participação (ou do `conversation`) = apagar o assunto localmente (mensagens, anexos, chaves);
  - organização fora de `organizationIds` = apagar os assuntos dela;
  - assunto vivo que o app não tinha (alguém compartilhou com a pessoa) = buscar o histórico com
    `conversationId=<id>&since=0` e seguir com o cursor principal;
  - mensagem com `replacesMessageId` = edição (esconder a substituída);
  - sincronização completa periódica (ressalva "ordem de commit × `sync_version`" do `CLAUDE.md`).
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
