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

## Ideias para depois (não fazer agora)
- Configuração inicial do Hub pelo app via **Bluetooth** (no lugar do código falado; resolve o idioma).
- Visitante em Hub alheio.
