# Agente do PC e cérebro da nuvem (parte do back): design

Data: 21/11/2026. Primeira das três specs do produto "nuvem ativa primeiro": **back** (esta) → agente do PC
(`vaulter-hub-back`) → web (`vaulter-hub-app`). As duas próximas têm specs próprias e partem do contrato fixado aqui.
Base: spec da nuvem ativa (`2026-11-10-active-cloud-design.md`), spec dos Hubs (`2026-11-01-hubs-design.md`), spec dos
assuntos (`2026-11-09-conversations-design.md`) e `docs/hubs/hub-lifecycle.md`.

## 1. Intenção

A nuvem ativa vira o **produto primário** e sai antes do Hub físico. Qualquer PC (Windows e Linux primeiro, Mac
depois) vira um Hub instalando um agente, que vem de bônus na assinatura da nuvem. O primeiro cliente é uma
**empresa que usa a IA "plug and play"**: um curador monta a base de conhecimento do espaço; quem usa (ex.: a
contabilidade) conversa pela web e a IA age no PC dessa pessoa: ferramentas MCP (principal), navegador (o que não tem
API) e uma pasta liberada. A empresa controla o que a IA pode fazer por uma **ACL gerenciada pelo admin**.

Por quê: vender o que já está construído, mais barato e imediato, sem esperar o hardware. O Hub físico continua
vendendo o que só ele faz (escuta de longe com vários microfones, sempre ligado, sensores, corpo).

Esta spec cobre o que o **back** precisa ter para isso: o agente como um tipo de Hub, o passo do cérebro, a ACL e a
auditoria das ações.

## 2. Objetivos, não objetivos e antiobjetivos

**Objetivos**
- O agente do PC entra pelo mesmo caminho do Hub (apresentação, reivindicação, vínculo, espaços instalados), marcado
  como `pc`.
- Rota do **passo do cérebro**: o agente manda o contexto da conversa e recebe o próximo passo do modelo (texto ou
  chamada de ferramenta), com prompt, RAG do espaço e orçamento centralizados no back.
- **ACL por organização**: o admin define o que a IA pode fazer no PC (permitir, pedir confirmação, negar), por
  ferramenta, pasta e domínio de navegador, para todos ou por pessoa. O back filtra o que oferece ao modelo e o agente
  aplica de novo localmente.
- **Auditoria** das ações executadas no PC, sem conteúdo, legível pelo admin.
- Reaproveitar tudo que já existe: identidade do Hub, executor do assunto, caixa de entrada com ack, feeds, backup,
  nuvem de reserva, orçamento de IA.

**Não objetivos (desta spec)**
- O agente em si (Python, bandeja, MCP, navegador): spec do `vaulter-hub-back`.
- A web (conversa, tela da ACL, envio do curador pela web): spec do `vaulter-hub-app`.
- Controle da tela do PC.
- Malha de dispositivos, containers na nuvem e o cliente desenvolvedor.
- Desacoplar o `vaulter-hub-back` do Raspberry Pi.
- Papéis próprios de organização (a ACL usa "todos" e "pessoa").

**Antiobjetivos (seria um fracasso mesmo funcionando)**
- O back executar ou mandar executar uma ação no PC sem que o próprio agente confira a ACL.
- Texto em claro da conversa, de resultado de ferramenta ou de pasta guardado no banco, em log, no Sentry, na auditoria
  ou em payload de tarefa.
- Um agente de uma pessoa agindo a pedido de outra pessoa.
- Tarefa do pg-boss ou conexão do pool presa esperando a confirmação de alguém.

## 3. Restrições

- Tudo da nuvem ativa continua valendo: só espaço `active_cloud`, termo aceito, orçamento > 0, nada legível em log,
  nenhuma chamada de rede segurando transação, orçamento reservado antes e acertado depois.
- O conteúdo segue cifrado pelo cliente. O back só vê texto em claro **em memória, durante o passo**, como já vê no
  responder da nuvem. Além do conteúdo do espaço, passam a ir ao modelo dados do PC (resultados de MCP, páginas do
  navegador, arquivos da pasta liberada): isso exige **uma versão nova do termo da nuvem ativa** (decisão do Jonas,
  21/11/2026; ver 5.8).
- Regra "o Hub responde primeiro, a nuvem é a reserva" (`hub-lifecycle.md`) continua de pé.
- Convenções do repositório: monólito modular, domínio puro, RLS por organização, erros com `type` estável, UUID v7,
  migrations imutáveis para catálogos.

## 4. Abordagens consideradas

A pergunta era como a IA pede uma ação ao PC e recebe o resultado, sabendo que uma confirmação da pessoa pode levar
minutos.

- **A. A nuvem conduz o laço e as ações viajam como mensagens cifradas no assunto.** O responder grava "faça X", o
  agente pega pelo feed, executa e responde com outra mensagem; o job pausa e retoma.
  - A favor: tudo cifrado e auditável, e aguenta o PC cair no meio.
  - Contra: o responder vira uma máquina de estados que pausa e retoma (a parte mais complexa), e cada passo paga a
    latência da sondagem.
- **B. A nuvem conduz o laço por um canal ao vivo (WebSocket) com o agente.**
  - A favor: o laço continua simples.
  - Contra: o job fica preso durante a confirmação, e a infra é nova (WebSocket e saber em que instância o agente
    está).
- **C. O agente conduz o laço, e a nuvem entrega cada passo do cérebro.** (**escolhida pelo Jonas, 21/11/2026**)
  - A favor: reaproveita o contrato do Hub executor; a espera da confirmação fica no PC, sem prender nada no servidor;
    prompt, RAG e orçamento ficam num lugar só.
  - Contra: rota nova, e o texto da conversa passa em claro pelo back a cada passo, junto com dados do PC (exige
    o espaço em `active_cloud` e um termo novo que cubra o agente, ver 5.8).

Consequência de C: o agente é o **executor do assunto**, como o Hub. Ele confirma (ack) a mensagem da pessoa, conduz o
laço chamando o passo do cérebro, executa as ferramentas sob a ACL e manda a resposta cifrada como mensagem do
executor. Com o PC desligado, a nuvem de reserva que já existe responde só com o conhecimento, 30 s depois.

## 5. Design

### 5.1 O agente como um tipo de Hub

- Coluna nova `hubs.kind`: `appliance` (o Hub físico) ou `pc` (o agente). Imutável depois de criada.
- **Declarada na apresentação, assinada.** Rótulo novo `hub-enroll-v2` com os campos do v1 mais `kind`. O servidor
  continua aceitando `hub-enroll-v1` (= `appliance`), então o Pi atual não muda. Formato, vetor e receita Python em
  `docs/crypto/hub-identity.md`. `hub_enrollments.kind` guarda o que veio e a reivindicação copia para o Hub.
- **Um agente é de uma pessoa só.** Num Hub `pc` não se atribui `hub_operator` nem `hub_user` (422
  `agent-not-shareable`), e o membro de organização vinculada **não** ganha o papel implícito `hub_user` que ganharia num
  aparelho. Só o dono tem acesso. Uma pessoa pode ter mais de um agente (desktop e notebook).
- O resto é o caminho do Hub sem mudança: reivindicação por código, vínculo com a organização da empresa (pela política
  dela), `hub_space`, Sala, token por desafio, sincronização, desregistro.
- A Sala funciona igual. É o caminho do **curador**: o agente dele, com o espaço na Sala como `space_editor`, envia a
  pasta sincronizada pelo contrato do backup que já existe (manifesto + objetos cifrados). Nada novo no back para isso.
- `kind` sai em `GET /hubs`, `GET /hubs/:id`, na sincronização (`hub`) e na busca da plataforma.

### 5.2 Assuntos com o agente como executor

- Sem mudança de regra: o executor é um Hub cujo dono participa e que tem o espaço instalado. A web cria o assunto com
  o agente da pessoa como executor e com a nuvem de reserva ligada (`serverWrappedKey`), para haver resposta com o PC
  desligado.
- **A ação roda no PC de quem pediu.** O passo do cérebro só oferece ferramentas do PC quando o **autor da mensagem
  sendo respondida é o dono do agente**. Num assunto compartilhado, a pergunta de outro participante é respondida pelo
  agente só com conhecimento (sem ferramentas). Isso impede uma pessoa de agir no PC de outra.
- O agente segue o contrato do executor de `hub-lifecycle.md` (executar só depois do 200 do ack; ack 404 = descartar).

### 5.3 Passo do cérebro

`POST /hub/conversations/:id/brain/step` (`@HubAuth()`, só Hub `pc`; um aparelho recebe 404 igual a rota inexistente
até ser decidido usá-la nele).

**Pedido** (texto em claro, só em memória):
```
{
  messageId,            // a mensagem da pessoa que o agente confirmou (ack) e está respondendo
  stepIndex,            // 0, 1, 2... dentro desta resposta
  history: [ { id, author: 'person'|'hub'|'cloud', authorUserId?, text } ],   // até RESPONDER_HISTORY_MESSAGES
  turns: [ { role: 'assistant'|'user', content: LlmContentBlock[] } ],         // os passos anteriores desta resposta:
                                                                               // chamadas de ferramenta e resultados
}
```
**Resposta**:
```
{ kind: 'final', text }                                            // o agente cifra e manda como mensagem
| { kind: 'tools', text?, toolCalls: [ { id, name, input, effect: 'allow'|'confirm' } ] }
| { kind: 'refused', reason }                                      // orçamento, limite de passos...
```

**O que o back confere, nesta ordem, antes de qualquer custo:**
1. Hub `pc`, executor do assunto, em organização com vínculo aprovado (senão o mesmo 404 `conversation-not-found`).
2. Espaço em `active_cloud` (senão 422 `cloud-not-active`) e a organização com um termo aceito que cobre o agente
   (senão 422 `cloud-terms-agent-not-accepted`; ver 5.8).
3. `messageId` é mensagem de pessoa, confirmada **por este Hub** (`acked_by_hub_id`) e ainda sem resposta do executor
   depois dela (senão 409 `brain-step-not-owned`).
4. Chamadas ao modelo nesta mensagem < `BRAIN_MAX_CALLS` (ver "Contagem dos passos"). O contador fica numa tabela
   só de ids (`agent_brain_steps`: organização, assunto, mensagem, chamadas, custo), para o limite não depender do
   agente. O ack do agente ainda está no prazo (ver "Prazo do ack do agente").
5. Tamanho: corpo até 256 KiB; cada resultado de ferramenta até 32 KiB (o agente corta antes, com aviso no texto).

**O que o back faz** (fora de transação, como o responder): reserva o orçamento (`AiBudget.tryReserve`, `kind:
'agent'`), embute a pergunta e busca os trechos do espaço (só no passo 0; os trechos vão no prompt de todos os passos),
monta o prompt versionado (o do Antares com uma seção "agindo no PC" e a lista das ferramentas permitidas), chama o
modelo **uma vez** e acerta o orçamento. Não guarda nada do conteúdo.

**Ferramentas oferecidas ao modelo** = catálogo do agente (5.4) ∩ ACL efetiva para o dono (5.5), sem as negadas. Cada
`toolCall` volta com o `effect` da ACL (`allow` ou `confirm`); chamada a ferramenta fora do que foi oferecido é
descartada pelo back e vira um resultado de erro no passo seguinte.

**Ferramentas de documento** (`propose_document` / `record_document`): rodam **no back**, dentro do próprio passo,
como no responder: o back executa e chama o modelo de novo, e só devolve ao agente quando há texto final ou ferramenta
do PC. A trava de confirmação (`confirmedProposal`) é conferida contra o histórico **decifrado pelo servidor** (as
cópias da nuvem de reserva, que a web sempre liga), nunca contra o `history` mandado pelo agente. A gravação usa o
`CloudDocumentWriter` em nome de quem confirmou (precisa de `memory.write`, como hoje), e o botão `documentDecision` da
web continua valendo. Sem a reserva ligada no assunto, as ferramentas de documento não são oferecidas. Cada chamada ao
modelo dentro do passo conta no limite de passos e no orçamento.

**O agente**: executa `allow` direto e pede confirmação para `confirm` **na bandeja do próprio PC** (decisão do
Jonas: a bandeja só com confirmações e aviso do que está fazendo). A confirmação nunca passa pelo back nem pelo assunto.
Ele também confere a ACL local de novo (5.5), registra a ação (5.6) e chama o próximo passo com o resultado. No
`final`, cifra a resposta e manda como mensagem do executor (`POST /hub/conversations/:id/messages`).

**Prazo do ack do agente.** Um ack de Hub `pc` vale por `AGENT_ACK_LEASE_MS` (proposta: 15 min), renovado a cada passo
do cérebro e por `POST /hub/conversations/:id/messages/:messageId/lease` enquanto uma confirmação espera na bandeja.
Vencido o prazo sem resposta do executor, a mensagem volta a `pending` (`requeueAckedBy`, `requeued_at` novo), o que
dispara o `CloudReservePendingHooks`, e a nuvem de reserva responde só com conhecimento. A varredura é uma tarefa
agendada do pg-boss, e o prazo é uma coluna nova na mensagem (`acked_lease_until`, só para ack de Hub `pc`). Ações já
executadas no PC ficam, registradas na auditoria. Um passo ou uma resposta do agente depois do prazo dá 409
`brain-step-not-owned`. Assim o PC desligado no meio nunca deixa a pergunta presa.

**Contagem dos passos.** O back conta **chamadas ao modelo** por mensagem (`agent_brain_steps.calls`), e não o
`stepIndex` que o agente diz. Repetir um passo depois de uma queda conta de novo e é cobrado de novo. Por isso o
limite é `BRAIN_MAX_CALLS` = 16 chamadas por mensagem (12 passos mais uma folga para retomadas). O `stepIndex` só
serve para o registro.

**Rate limit**: `brainStep` por Hub, proposta 600/h.

### 5.4 Catálogo de ferramentas do agente

`PUT /hub/agent/tools` (`@HubAuth()`, só `pc`): o agente publica o que sabe fazer, substituindo a lista anterior.
```
{ tools: [ { name, title, description, inputSchema, category: 'mcp'|'browser'|'folder' } ] }   // até 200
```
- Nomes com prefixo: `mcp:<servidor>/<ferramenta>`, `browser:<ação>`, `folder:<read|write|list>`.
- Tabela `agent_tools` (Hub, nome, título, descrição, schema, categoria). É metadado de software, não conteúdo do
  cliente, então pode ser legível, mas fica com RLS do dono do Hub.
- `GET /hubs/:id/agent/tools` (dono) e a lista consolidada por organização para o admin montar a ACL
  (`GET /organizations/:orgId/agent/tools`: nomes e títulos de todos os agentes vinculados, sem dizer de quem).

### 5.5 ACL da organização

- Permissão nova `org.agents.manage` (no `org_admin`), por migration nova no catálogo RBAC.
- **Regra** = (quem, recurso, efeito):
  - quem: `all` (todos os membros) ou `user:<userId>`;
  - recurso: `tool:<nome ou prefixo*>` (ex.: `tool:mcp:erp/*`), `folder:<caminho>` (só dentro da pasta liberada que o
    agente declara) ou `domain:<host ou *.host>` (navegador);
  - efeito: `allow`, `confirm` ou `deny`.
- **Onde cada recurso vale:** `folder:` só para as ferramentas `folder:*`, e `domain:` só para as `browser:*`. As
  ferramentas MCP são avaliadas só pelo nome: elas falam com sistemas da empresa que o admin já escolheu ligar. O
  contrato do catálogo fixa os argumentos: toda ferramenta `folder:*` tem `path` e toda `browser:*` tem `url`.
- **Caminho:** sempre **relativo à pasta liberada**, com `/`, sem `..`, normalizado pelo agente e pelo back. A pasta
  liberada em si (o caminho absoluto no PC) fica só no agente e nunca vai ao back.
- **Combinação:** numa chamada `folder:*` ou `browser:*`, vale a **mais restritiva** entre a regra da ferramenta e a
  regra do caminho ou do domínio. Como isso depende dos argumentos, o back oferece a ferramenta quando a regra dela
  não é `deny` e marca o `effect` de cada chamada lendo `path`/`url` do `input`. Argumento ausente ou malformado vira
  `deny`.
- **Avaliação**: a regra de pessoa vence a de `all`; dentro do mesmo "quem", a mais específica vence; empate = a mais
  restritiva (`deny` > `confirm` > `allow`). **Sem regra = `deny`.**
- **Escritas sempre `confirm` no mínimo?** Não por regra fixa: o admin decide. A web sugere um modelo inicial (leitura
  `allow`, escrita `confirm`).
- Tabela `agent_policies` (organização, versão, regras em JSON validado, quem mudou, quando) com uma linha por versão
  (append-only, a atual é a maior). Mudar = versão nova inteira (`PUT /organizations/:orgId/agent-policy`
  `{ baseVersion, rules }`, 409 `agent-policy-version-stale` se outro admin mudou antes), auditado
  `organization.agent_policy.changed`.
- `GET /organizations/:orgId/agent-policy` (todo membro: a pessoa vê o que a IA pode fazer no PC dela).
- **O agente baixa a política** em `GET /hub/agent/policy`: a efetiva para o dono, de **cada** organização vinculada,
  com a versão. Ele aplica a da organização do espaço do assunto. Recarrega quando a versão muda (vem também como
  item `agent_policy` no `GET /hub/sync`, para não precisar de sondagem própria).
- **Organização pessoal**: a própria pessoa é a admin e gerencia a ACL dela.
- **Dupla checagem**: o back não oferece o que é `deny` e marca o efeito de cada chamada; o agente confere de novo pela
  política local antes de executar (o back pode estar desatualizado ou comprometido; a política local é a última
  palavra, e uma divergência é registrada na auditoria).

### 5.6 Auditoria das ações

- `POST /hub/agent/actions` (`@HubAuth()`, só `pc`, em lote de até 100): o agente registra cada ação depois de
  executada ou recusada.
  ```
  { items: [ { id (UUID v7), conversationId, messageId, toolName, effect, decision: 'executed'|'declined'|'blocked'|'failed',
               startedAt, durationMs, policyVersion } ] }
  ```
  Idempotente pelo `id`. **Nunca** argumentos, resultados, caminhos de arquivo nem URLs.
- Tabela `agent_action_logs` (append-only, RLS por organização, só ids, nome da ferramenta, decisão e tempos).
- `GET /organizations/:orgId/agent-actions?userId=&hubId=&cursor=` (`org.agents.manage`), e a pessoa vê as do próprio
  agente em `GET /hubs/:id/agent/actions`.
- Retenção: a mesma dos registros de auditoria (sem limpeza na v1).

### 5.7 O que não muda

- Nuvem de reserva, responder da nuvem, orçamento, indexação, backup e feeds ficam como estão. A única mudança no
  responder é o `kind: 'agent'` novo no livro de uso (`cloud_ai_usage`), para o admin ver quanto custou agir no PC.

### 5.8 Termo novo da nuvem ativa

- Uma versão nova em `cloud_terms`, publicada por migration (como toda versão), cujo texto cobre mandar ao modelo os
  dados do PC trazidos pelas ferramentas do agente. **O texto é do Jonas** e entra junto com o texto final do termo,
  que já é uma pendência (a v1 é rascunho). Enquanto o texto não existir, a migration publica um rascunho marcado como
  provisório, como a v1.
- Coluna nova `cloud_terms.covers_agent` (booleana, imutável como o resto do termo). O passo do cérebro exige que a
  organização tenha aceitado **alguma** versão com `covers_agent = true` (o aceite fica em `cloud_term_acceptances`,
  como hoje). Não exige a versão mais recente: um termo futuro que mude outra coisa não derruba os agentes que já
  funcionam. Quem já aceitou a v1 continua com a nuvem ativa como está, mas o agente só funciona depois do novo aceite.
- `GET /organizations/:orgId/cloud/terms` passa a trazer `agentCovered: boolean`, para a web pedir o aceite antes de
  oferecer o agente.
- Autorizar e ligar a nuvem num espaço continuam exigindo só o termo **atual** aceito, como hoje. Como a versão nova
  passa a ser a atual, todo aceite novo já cobre o agente.

## 6. Erros novos

- 422 `agent-not-shareable` (papel de Hub num agente), 422 `cloud-not-active` (passo num espaço fora da nuvem ativa),
  422 `cloud-terms-agent-not-accepted` (nenhum termo que cobre o agente aceito),
  409 `brain-step-not-owned`, 422 `brain-step-limit` (passou de `BRAIN_MAX_CALLS`), 409 `agent-policy-version-stale`,
  422 `agent-policy-invalid` (regra malformada, com a lista das inválidas).
- Orçamento recusado no passo: responde `{ kind: 'refused', reason: 'ai-budget-exceeded', resetsAt }` (200, não erro:
  o agente mostra o aviso e manda a mensagem fixa já usada pelo responder).

## 7. O que fica para o builder (e chamadas do Claude)

Chamadas do Claude (o Jonas pode corrigir):
- `kind` declarado e assinado na apresentação (`hub-enroll-v2`), e não escolhido pelo dono na reivindicação.
- Agente nunca compartilhável (sem `hub_operator`/`hub_user`, sem o `hub_user` implícito).
- Ferramentas do PC só quando quem pergunta é o dono do agente.
- ACL com `deny` como padrão, regra de pessoa vencendo a de todos, empate para o mais restritivo.
- Ferramentas de documento rodam no back, dentro do passo, conferidas contra o histórico decifrado pelo servidor, e
  ficam disponíveis a quem tem `memory.write` (não só ao curador).
- Prazo de 15 min no ack do agente, renovável, com a volta à fila para a nuvem de reserva.
- `folder:` e `domain:` valem só para as ferramentas de pasta e navegador; MCP só pelo nome; caminho relativo à pasta
  liberada; a mais restritiva vence.
- Contagem por chamadas ao modelo (retomada cobra de novo).
- Números: 16 chamadas por mensagem, 256 KiB por pedido, 32 KiB por resultado, 600 passos/h por Hub, 200 ferramentas
  no catálogo.

Para o builder decidir sem mudar o produto: nomes de tabelas e colunas, formato exato do JSON das regras, ordem de
locks das tabelas novas (sugestão: organização → política; Hub → catálogo), texto da seção "agindo no PC" do prompt
(versão nova do prompt), estimativa de custo de um passo para a reserva, e onde o item `agent_policy` entra no leitor
da sincronização.

## 8. Pronto quando

- Um agente `pc` se apresenta com `hub-enroll-v2`, é reivindicado, vinculado à organização e recebe um espaço.
- Uma mensagem num assunto com esse agente como executor é confirmada por ele e respondida pelo passo do cérebro com
  pelo menos uma chamada de ferramenta, com orçamento reservado e acertado.
- A ACL do admin muda o que é oferecido ao modelo e o que o agente recebe em `GET /hub/agent/policy`.
- As ações aparecem na auditoria sem conteúdo.
- Com o agente desligado, a nuvem de reserva responde como hoje.
- e2e cobrindo: o 404 para aparelho e para Hub que não é executor, a pergunta de outro participante sem ferramentas,
  `deny` nunca oferecido, o limite de passos, a recusa de orçamento e a idempotência da auditoria.
- `CLAUDE.md`, `docs/hubs/hub-lifecycle.md` e `docs/crypto/hub-identity.md` atualizados no mesmo trabalho.
