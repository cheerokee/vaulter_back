# Conversas (assuntos) como dado do espaço — design

Data: 09/11/2026 · Status: **aprovada em 09/11/2026 (implementada)** · Repositório: `vaulter_back` (módulo novo `conversations`)

Nasce de uma conversa do Jonas com o Claude que começou na "caixa de entrada" e se juntou ao copiloto pelo app
(`../vaulter-hub-back/docs/superpowers/specs/2026-11-09-copiloto-pelo-app-design.md`, seção "Onde mora o quê", já
alinhada com esta direção). Parte também da spec de integração
(`../valter-valt-ai/docs/superpowers/specs/2026-10-24-api-de-integracao-design.md` §5.2, caixa de entrada) e do backup
(`2026-11-09-storage-backup-design.md`). Onde está escrito *"decisão do Claude"*, o Jonas não decidiu explicitamente.

## 1. Intenção

O copiloto (o Antares) conversa com a pessoa em **assuntos**: uma demanda com mensagens, áudio, imagens e documentos,
estado e plano. Hoje o desenho do copiloto guarda os assuntos só no Hub. Este módulo faz do assunto um **dado do
espaço**, com a cópia compartilhada no backend **cifrada** e sincronizada nos dois sentidos entre app, Hub e (no futuro)
nuvem. Assim:
- o app mostra o histórico e **manda demandas com o Hub desligado ou fora de alcance**; o Antares resolve quando o Hub
  voltar (é a **caixa de entrada**: mensagens novas esperando um executor);
- nada se perde se o app fechar, o celular trocar ou o Hub queimar;
- o mesmo formato serve depois para a **nuvem ativa** (executor na nuvem) e para os **integradores** (Orion, Salte)
  mandarem itens.

Ordem dos projetos (decisão do Jonas): **(1) este**; (2) nuvem ativa com termo de aceite; (3) executor na nuvem.

## 2. Objetivos, não objetivos e anti-objetivos

**Objetivos**
- **Assunto pertence a um espaço só** (frente = espaço). Mover para outro espaço = decifrar, cifrar com a chave do
  outro e lápide no antigo. Algo que interessa a duas frentes vira dois assuntos, com cópia explícita e um **link** por
  id; nunca um registro em dois espaços.
- **Assunto pessoal** (decisão do Jonas): cada assunto tem a **própria chave**, trancada só para os **participantes** e
  para o **executor** (o Hub onde o Antares trabalha). Outros membros do espaço não leem. **Compartilhar** é explícito:
  pôr pessoas (membros do espaço) ou "compartilhar com o espaço" (todas as pessoas do espaço).
- **Privado é privado** (decisão do Jonas): sem cópia para o kit da organização. Assunto cujo único participante perdeu
  a conta (e o código de recuperação) se perde.
- **O backend vê só metadado mínimo** (decisão do Jonas): estado do assunto, horários e participantes; **nunca** título,
  conteúdo, plano ou anexos em claro. Isso permite ordenar a lista e, num projeto seguinte, notificar no celular.
- **Mensagens e anexos** cifrados com a chave do assunto; anexos no S3 pelo mesmo mecanismo do backup e contando no
  tamanho do espaço.
- **Sincronização** de mão dupla: ids gerados no aparelho (UUID v7), versão por registro (`sync_version`), exclusão
  como lápide.
- **Caixa de entrada:** mensagem nova fica "pendente" até o executor confirmar que a pegou.

**Não objetivos (ficam para depois)**
- **Notificações no celular** (FCM/APNs): o backend passa a ter o estado; enviar push é um módulo próprio.
- **Nuvem ativa** e **executor na nuvem** (projetos 2 e 3).
- **Integradores** mandando itens (entra com a API de integração; o formato daqui já serve).
- **WebSocket** Hub ↔ backend (pendência conhecida); na v1 o Hub busca mudanças por sondagem longa (§4.6).
- Busca no conteúdo pelo backend (impossível com cifra; o app/Hub buscam localmente).
- O que o Antares faz com o assunto (plano, permissões, execução no PC): é da spec do copiloto.

**Anti-objetivos**
- O Vaulter ler título, conteúdo, plano ou anexo de um assunto (sem nuvem ativa).
- Um membro do espaço que não participa do assunto conseguir ler, ou descobrir o título.
- Quem saiu do assunto ou do espaço ler mensagens novas.
- Uma mensagem mandada pelo app com o Hub desligado se perder, ou ser executada duas vezes.
- Um registro pertencer a dois espaços.

## 3. Restrições

- Mesma cripto: libsodium, byte de versão, base64url, rótulos sem o nome do produto. Formato em
  `docs/crypto/conversations.md` (novo), alinhado a `docs/crypto/space-backup.md` e às cópias trancadas da chave do
  espaço (`docs/crypto/user-keys.md`: `0x01 ‖ crypto_box_seal`).
- Módulo `conversations` depende de `spaces`, `hubs`, `identity`, `storage` e `organizations` só pelo que exportam.
- Tabelas com `organization_id`, RLS por organização, FKs compostas para o espaço, timestamps, lápide e
  `sync_version`; runtime sem `DELETE`. **Mais uma trava de RLS** *(decisão do Claude)*: leitura de assunto e mensagens
  só para participante (`app.user_id`) ou executor (`app.hub_id`), além do escopo da organização.
- Postgres (o mesmo do backend), sem banco novo.

## 4. Como funciona

### 4.1 Assunto
- Campos visíveis ao backend: `id` (do aparelho), organização, espaço, quem criou, **dono atual**, `state`,
  `lastMessageAt`, `executorHubId` (nulo = sem executor), `keyVersion` atual, `keyRotationRequired`, `sync_version`.
- `state` *(lista alinhada à spec do copiloto)*: `aviso`, `trabalhando`, `na_fila`, `pede_sim`, `esperando_pc`,
  `concluido`, `arquivado`. Quem muda: o executor (trabalho) e participantes (arquivar/reabrir).
- **Cabeçalho cifrado** (`encryptedHeader`): título, plano e o que mais o copiloto quiser, cifrado com a chave do
  assunto; tamanho limitado (ex.: 16 KiB).
- **Criar:** membro do espaço com `memory.read` *(decisão do Claude: é uma conversa pessoal; o que o Antares grava
  no espaço passa pelas permissões normais)*, mandando as cópias trancadas da chave do assunto para si e para o
  executor escolhido. O executor pode ser omitido (assunto só no app, esperando a pessoa escolher).
- **Executor:** um Hub **cujo dono participa do assunto** (decisão do Jonas, opção "a": quem controla o aparelho pode,
  em tese, ler o que ele decifra; assim "privado é privado" vale de verdade) e em que o espaço está **instalado**
  (`hub_space`; a Sala não é exigida, porque a chave do assunto chega por cópia própria) *(decisão do Claude)*. Quem
  abre escolhe (padrão: o Hub dele). Num Hub de outra pessoa (ex.: o Hub da empresa, do admin), só compartilhando o
  assunto com o dono do Hub. **Afrouxar depois é barato** (regra de validação + aviso no app; pode virar opção por
  organização); o contrário seria caro.
- **Trocar de executor** = cópia para o Hub novo e **troca da chave** (o antigo conhecia a chave) *(decisão do Claude)*.
- **Executor deixa de valer** *(decisão do Claude)* quando o Hub é desregistrado, a organização é desvinculada dele, o
  espaço sai dele (`hub_space` com lápide) ou o dono do Hub deixa de participar do assunto: `executorHubId` volta a
  nulo, lápide nas cópias do Hub, `keyRotationRequired`; mensagens `pending` continuam esperando um executor novo. O
  `hubs` emite esses eventos por um gancho novo em `src/shared/application/` (como os outros ganchos), sem importar
  `conversations`.
- O **Hub também cria** assuntos (o "aviso" do copiloto): cria em nome de uma pessoa (dono), trancando a chave para ela
  e para si; precisa que a pessoa tenha papel no Hub e seja membro do espaço, e (regra do executor) que o dono do Hub
  seja essa pessoa ou também participe.

### 4.2 Chave do assunto e participantes
- Chave aleatória de 32 bytes por **versão**; cópia trancada (`crypto_box_seal`) para cada participante e para o
  executor, por versão. Todo participante tem cópia de **todas** as versões (senão perde o histórico), como no espaço.
- **Compartilhar:** um participante põe pessoas (membros do espaço com `memory.read`), mandando as cópias de todas as
  versões. "Compartilhar com o espaço" = pôr todas as pessoas do espaço de uma vez.
- **Poderes** *(decisão do Claude)*: o **dono** tira participantes, troca o executor, move e arquiva/reabre (o `state`
  é do assunto); **qualquer participante** põe pessoas e sai; cada um apaga **as próprias** mensagens (o executor, as
  dele).
- **Sair / ser tirado do assunto** ou **sair do espaço** (gancho `SpaceMemberLeftHooks`): lápide na participação e nas
  cópias, `keyRotationRequired`. Se quem sai é o dono do Hub executor, o executor também sai (§4.1). Enquanto a flag estiver ligada, o backend
  recusa mensagem nova (409, como o storage); qualquer participante restante **ou o executor** faz a troca (versão
  nova para os participantes ativos e o executor). *(decisão do Claude: o executor pode trocar porque já tem a chave e
  conhece as chaves públicas dos participantes pela sincronização; evita a fila parar.)*
- **Dono sai** e há outros: o participante mais antigo vira dono. **Último participante sai:** lápide no assunto
  (privado é privado; o conteúdo cifrado expira com a lixeira).
- **Mover para outro espaço** *(decisão do Claude)*: só o **dono**, pelo app. O app cria o assunto novo no destino
  (cabeçalho, mensagens e anexos cifrados de novo com chave nova, reenviados) com um campo `movedFrom`, e depois põe
  lápide no antigo. Participantes que não são membros do destino ficam de fora; o executor é escolhido de novo. O
  backend confere que o dono é membro dos dois espaços.

### 4.3 Mensagens
- `id` do aparelho, autor (pessoa ou executor), `keyVersion`, corpo cifrado com a chave do assunto (até **64 KiB**
  cifrado, no Postgres; maior vira anexo), referências a anexos, `sentAt`, `sync_version`.
- **Imutáveis**; apagar = lápide. Editar = mensagem nova que referencia a anterior *(decisão do Claude)*.
- **Idempotência:** reenviar o mesmo `id` não duplica (o app reenvia com segurança depois de falha de rede).
- **Caixa de entrada:** mensagem de pessoa nasce `pending`; o executor confirma (`ack`) quando pegou; o backend vê só
  isso (e a hora). Mensagem do executor nasce confirmada. Assunto sem executor guarda as pendentes até ter um.

### 4.4 Anexos
- Áudio, imagem, documento: objeto cifrado com a chave do assunto, enviado direto ao S3 por URL assinada, no
  caminho `orgs/<orgId>/spaces/<spaceId>/conversations/<conversationId>/<attachmentId>`, com o mesmo fluxo
  intenção → confirmação do storage (conferência de tamanho/sha256, cópia no S3, diário e reparo) e contando no uso do
  espaço *(decisão do Claude: reaproveitar o mecanismo do storage, com acesso conferido por participação no assunto, não
  por `memory.read` do espaço)*.
- Limite por anexo: 100 MiB *(decisão do Claude)*.
- Índice próprio de anexos (não o índice do backup do espaço), reaproveitando a porta `ObjectStore`, o diário e o reparo
  do storage *(decisão do Claude)*.

### 4.4.1 Retenção *(decisão do Claude)*
- O **texto das mensagens também conta** no uso do espaço (tamanho cifrado), além dos anexos.
- Mensagem ou assunto apagado (lápide) mantém o conteúdo cifrado por **30 dias**; depois, uma rotina **zera** o corpo
  (UPDATE, o runtime não precisa de `DELETE`) e o S3 expira os anexos pela regra de lixeira. A linha (id, lápide) fica
  para a sincronização.
- O **esvaziar lixeira** do Gestor não alcança assuntos privados de que ele não participa; o dono do assunto pode
  esvaziar a lixeira do próprio assunto.

### 4.5 O que o backend vê e guarda
- Vê: ids, espaço, participantes, dono, executor, estado, horários, tamanhos, versões, `ack`. Não vê: título, plano,
  conteúdo, nomes ou tipos de anexo.
- Auditoria (`audit_logs`) de compartilhar, tirar participante, mover e trocar executor, sem conteúdo.

### 4.6 Sincronização
- **Pessoa (app):** `GET` de mudanças por cursor de `sync_version` dos assuntos em que participa (assuntos, mensagens,
  participações, cópias da chave dela) — mesmo padrão da sincronização do Hub (lápides incluídas).
- **Executor (Hub):** o mesmo para os assuntos em que é executor, com **sondagem longa** *(decisão do Claude)*: o pedido
  fica aberto até ~25 s esperando mudança, para o Antares reagir em segundos a uma mensagem nova sem WebSocket.
- Quando o app alcança o Hub direto, conversa com o Hub; o Hub grava no backend. Fonte compartilhada = backend.
- Empate de versão: não há (uma versão por linha, de uma sequência). Ordem de commit: a versão é dada **no COMMIT**, na
  ordem dos commits (constraint trigger adiado + um advisory lock + uma sequência; migration
  `ConversationFeedCommitOrder`, que substituiu a versão por xid de `ConversationFeedSafeHorizon`), sem a ressalva do Hub.

### 4.7 Limites
- Assuntos por espaço, participantes por assunto (ex.: 50), mensagens por minuto por pessoa e por executor, tamanho do
  cabeçalho e da mensagem: números finais com o builder, com rate limit por usuário e por Hub.

## 5. Deixado para quem constrói
1. Formato exato em `docs/crypto/conversations.md` (cabeçalho, mensagem, anexo, cópias), com vetor de teste e AD que
   amarra ao espaço, ao assunto, à versão e ao id do registro.
2. Tabelas, RLS (organização + participante/executor), FKs compostas, migrations e DER.
3. Rotas, códigos de erro e limites; rate limits.
4. Como reaproveitar o mecanismo do storage para anexos sem duplicar código.
5. O formato da sondagem longa e o tempo de espera.
6. Atualizar `CLAUDE.md`, `docs/hubs/hub-lifecycle.md` (o Hub como executor) e `docs/app/pendencias-do-app.md`.

## 6. Em aberto / para depois
- Notificações no celular (projeto seguinte, usa `state` e `lastMessageAt`).
- Nuvem ativa com termo de aceite (projeto 2) e executor na nuvem (projeto 3).
- Integradores mandando itens para a caixa de entrada (com a API de integração).
- WebSocket Hub ↔ backend no lugar da sondagem longa.
- Cifrar também estado e horários, se o metadado visível der problema (decisão do Jonas: "se der problema, a gente
  muda").
