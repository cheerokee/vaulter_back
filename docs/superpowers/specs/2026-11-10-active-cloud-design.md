# Nuvem ativa — design

Data: 10/11/2026 · Status: **aprovada em 10/11/2026; implementada em 11/11/2026** (plano
`docs/superpowers/plans/2026-11-10-active-cloud.md`; desvios em §7) · Repositório: `vaulter_back` (módulo novo `cloud`)

Nasce de uma conversa do Jonas com o Claude. Parte da spec de produto
`../valter-valt-ai/docs/superpowers/specs/2026-10-24-organizacoes-espacos-e-nuvem-design.md` (§6 modo de nuvem por
espaço, §7 decisões desde a v1, §10 conectores), das specs de storage (`2026-11-09-storage-backup-design.md`) e de
conversas (`2026-11-09-conversations-design.md`), e da decisão do Jonas de 09/11 (nuvem ativa = serviço contratado,
com termo de aceite; ordem: conversas → nuvem ativa → executor na nuvem). Onde está escrito *"decisão do Claude"*, o
Jonas não decidiu explicitamente.

## 1. Intenção

Hoje todo espaço é **só cifrado**: o Vaulter guarda o backup e não lê nada, e o Antares só trabalha no Hub. A
**nuvem ativa** é uma opção **por espaço**, contratada e com **termo de aceite**, em que o Vaulter passa a ler aquele
espaço para que o Antares **responda de qualquer lugar**, com o Hub desligado, longe ou roubado.

Cenários do Jonas que este projeto resolve:
- **Hub desligado, dúvida urgente de cliente** (ex.: como aprovar um processo de compras de última hora no Orion): pergunta
  pelo app, o Antares responde com o conhecimento do espaço.
- **Hub roubado:** o conhecimento continua acessível pela nuvem na hora (e o backup restaura um Hub novo).

E prepara o que vem depois (fora deste projeto):
- **Executor na nuvem completo** (projeto 3): container na AWS executando tarefas quando o PC não aguenta, ferramentas,
  e no limite o **Hub hospedado**.
- **Evolução das respostas:** trazer os documentos e gerar artefatos, como o Claude faz.
- **Ideia de negócio anotada:** "Hub em software" (o software do Pi num PC ou VM da pessoa), sem nuvem ativa, como
  entrada barata.

**Posicionamento (conversa):** o Hub é o **cofre e o corpo** (privacidade total, presença física, offline, sem custo
por uso); a nuvem ativa é o **cérebro que acompanha quando você está longe**. Os dois juntos são o produto completo.

## 2. Objetivos, não objetivos e anti-objetivos

**Objetivos**
- **Ligar/desligar por espaço** com **termo de aceite** registrado (versão, quem, quando, para qual organização e
  espaço). Quem liga: na organização pessoal, a própria pessoa; na empresa, um admin (spec de produto §6).
- **Tudo do espaço vai para a nuvem** (decisão do Jonas): documentos, e também os **espelhos de conector** (que hoje
  não entram no backup). Quem quer algo só no Hub usa um espaço sem nuvem ativa.
- **A nuvem monta o índice sozinha a partir do backup cifrado** (decisão do Jonas, opção "b"): decifra com a chave do
  espaço, lê os arquivos, divide em trechos, calcula embeddings e guarda no **pgvector**. Funciona mesmo ligando com o
  Hub desligado ou roubado.
- **Responder no assunto** (conversas): a nuvem vira um **executor** nos espaços com nuvem ativa — **Hub primeiro,
  nuvem de reserva** (decisão do Jonas): o Hub responde quando está online; a nuvem responde quando ele está fora de
  alcance, ou quando a pessoa escolhe "responder pela nuvem" num assunto. A resposta entra como mensagem normal.
- **Documentar pela conversa** (decisão do Jonas): o Antares grava documentos no espaço do assunto (decisão, convenção,
  ata, planejamento), por pedido ou de forma natural, e eles viram índice do RAG — como o Claude faz com specs e notas.
- **Alerta de confidencialidade** (decisão do Jonas): antes de gravar, o executor confere quem enxerga o espaço; se o
  conteúdo parecer confidencial e o espaço for amplo, **avisa e pergunta** (gravar mesmo assim, gravar em espaço mais
  restrito, não gravar). Nunca grava em silêncio.
- **Orçamento de IA por organização** (decisão do Jonas, no modelo do orçamento de Actions do GitHub): limite mensal de
  gasto com respostas e indexação, medido por uso, ajustado pelo **financeiro da plataforma**, com avisos perto do fim e
  parada clara ao estourar.

**Não objetivos (ficam para depois)**
- Trazer documentos na resposta e **gerar artefatos** (evolução declarada pelo Jonas).
- Executor na nuvem com **ferramentas**, containers, tarefas longas, Hub hospedado (projeto 3).
- OCR de imagens e transcrição de áudio na indexação.
- Cobrança automática e contratação pela própria organização (o financeiro ajusta à mão, como a franquia).
- API de integradores consultando a nuvem.
- "Hub em software".

**Anti-objetivos**
- Ler um espaço que **não** está em nuvem ativa, ou ler antes do aceite do termo.
- Continuar com qualquer dado legível (chave, trechos, embeddings, textos) depois de desligar.
- Um membro descobrir pelo RAG o conteúdo de **conversas privadas** de outros.
- Gravar algo confidencial num espaço amplo **sem alertar**.
- Gasto de IA sem teto, ou estourar o orçamento em silêncio.
- A nuvem roubar o papel do Hub quando ele está online.

## 3. Restrições

- Módulo novo `cloud` (nome técnico sem o nome do produto) dependendo de `spaces`, `storage`, `conversations`,
  `organizations`, `identity`, `platform` só pelo que exportam; ninguém importa `cloud`.
- **Chave do servidor:** um par X25519 do servidor, com a privada guardada cifrada pelo **KMS da AWS** (envelope;
  LocalStack em dev); a chave do espaço chega ao servidor como **cópia trancada** para a pública do servidor, feita no
  app por um membro com a chave. Só o processo de indexação/resposta abre, em memória.
- **Mesmo modelo de embedding do Hub** (`nomic-embed-text`, registrado em cada trecho, spec de produto §7.4),
  rodando do nosso lado (serviço novo no compose em dev).
- Modelo de linguagem: **Claude pelo Amazon Bedrock** (decisão do Jonas, 10/11/2026), na mesma conta e região da AWS do
  backend (`us-east-1`): autenticação pelo papel IAM, sem chave extra, cobrança junto com a AWS, dados sem sair da AWS e
  sem uso para treino (política padrão do Bedrock), o que simplifica o termo de aceite e a LGPD. O campo
  existente `spaces.allow_online_llm` (o espaço permite modelo online) precisa estar ligado para a nuvem responder
  *(decisão do Claude: ligar a nuvem ativa exige/ liga `allow_online_llm`)*.
- **Tarefas em segundo plano:** indexação e reindexação entram no **pg-boss** (decisão transversal do projeto; ele entra
  agora), não na requisição.
- Postgres único com pgvector (sem banco novo); dado legível com `organization_id` e RLS por organização; nunca nos
  logs/Sentry.
- Nome do produto nunca em rótulo, tabela, rota ou bucket.

## 4. Como funciona

### 4.1 Termo e ligar/desligar
- **Termo** versionado (texto em pt-BR, guardado como versão com hash; o texto final é do Jonas). Aceite registrado:
  versão, organização, quem aceitou, quando, IP *(decisão do Claude: aceite por organização, uma vez por versão; ligar
  cada espaço registra quem ligou e quando; versão nova do termo exige novo aceite antes de ligar espaço novo, os já
  ligados continuam)*.
- **Ligar** (`cloud_mode = active_cloud`), em **dois passos** *(decisão do Claude, depois da revisão: o admin não é
  membro do espaço e não tem a chave)*: (1) quem decide (admin na empresa, a própria pessoa na pessoal) aceita o termo e
  **autoriza** aquele espaço (`allow_online_llm` ligado, orçamento > 0); o espaço fica "autorizado, esperando a chave";
  (2) o **Gestor** do espaço (membro com a chave) manda a cópia trancada da chave do espaço (todas as versões) para a
  chave do servidor e o espaço passa a `active_cloud`. Na pessoal, os dois passos são da mesma pessoa. Dispara a
  **indexação inicial** (pg-boss). Espaço órfão não liga (não há quem mande a chave). **Todos os membros** veem, no app,
  um aviso permanente de que o espaço está em nuvem ativa (o Vaulter lê).
- **Troca de chave do espaço** num espaço em nuvem ativa: a troca precisa incluir a cópia para o servidor (como os Hubs
  da Sala), senão 409 com o servidor faltando *(decisão do Claude)*.
- **Desligar:** lápide/apagamento da cópia da chave do servidor, de todos os trechos, embeddings e textos extraídos do
  espaço (dado legível não tem lixeira: apagado de fato), `cloud_mode = encrypted_backup`; auditado. O backup cifrado
  não muda.
- Organização sai da nuvem (termo revogado, orçamento zerado não conta como desligar): só o desligar apaga.

### 4.2 Indexação a partir do backup
- **Fonte única:** o backup cifrado do espaço (`storage`). A nuvem lê o **manifesto** do Hub (objeto cifrado que diz o
  que é cada objeto: nome, tipo, origem/conector) e os objetos, decifra com a chave do espaço (formato em
  `docs/crypto/space-backup.md`) e indexa. **O backend define o contrato do manifesto** *(decisão do Claude, depois da
  revisão)* num documento novo `docs/hubs/space-manifest.md`, que a sessão do `vaulter-hub-back` implementa: o manifesto
  tem um **`objectId` fixo derivado do espaço** (ex.: UUID v5 do `spaceId` com um rótulo sem o nome do produto; não
  revela nada novo) e lista cada arquivo (nome, tipo, origem/conector, data) com os `objectId` das partes em ordem
  (arquivo inteiro = uma parte; arquivos grandes em partes, que a nuvem junta antes de ler). Versionado (byte de versão
  dentro do JSON cifrado). Até o Hub implementar, os e2e simulam o Hub com esse formato.
- **Manifesto da nuvem** *(decisão do Claude)*: os documentos que a nuvem grava (§4.3) são objetos do backup cifrados
  com a chave do espaço (contam no tamanho do espaço) e ficam listados num **segundo manifesto, o da nuvem** (outro
  `objectId` fixo derivado do espaço), escrito só pelo servidor. A indexação lê os dois manifestos; assim nada some numa
  reindexação nem com o Hub roubado que nunca volta.
- **Espelhos de conector** passam a entrar no backup **nos espaços com nuvem ativa** (cifrados como o resto), para a
  nuvem indexá-los; nos outros, continuam fora (spec de produto §10).
- **Formatos v1** *(decisão do Claude)*: PDF, Word (docx), planilhas (xlsx/csv), Markdown, texto, HTML.
- **Incremental:** cada confirmação de envio num espaço em nuvem ativa enfileira a (re)indexação do objeto; apagar
  remove os trechos. Reindexação completa sob demanda (ligar, troca de modelo).
- **Conversas não entram no índice do espaço** *(decisão do Claude: são privadas de quem participa; o índice é de todos
  os membros)*; ao responder, a nuvem usa o histórico do **próprio** assunto.
- Trechos guardam espaço, objeto/versão, posição, texto, embedding, modelo de embedding (spec de produto §7.4).

### 4.3 Responder (a nuvem como executor)
- Num espaço com nuvem ativa, **todo assunto já nasce com a nuvem como executor de reserva** (decisão do Jonas, opção
  "a"): o app tranca também uma cópia da chave do assunto para a chave do servidor (todas as versões; a troca de chave do
  assunto passa a incluir o servidor enquanto a reserva estiver ligada). O **dono pode desligar a nuvem por assunto**
  (lápide na cópia do servidor e troca de chave). Assuntos que já existiam quando o espaço passou a nuvem ativa ganham a
  reserva quando um participante abre o assunto no app (o app manda a cópia) *(decisão do Claude)*. Isso exige mudanças
  no módulo `conversations`: um executor/autor "nuvem" ao lado do Hub (CHECKs, RLS, feeds, `ack`, `requeueAckedBy`,
  `key-rotation-mismatch`), detalhadas no plano.
- **Quem responde:** se o Hub executor está online (feed do executor ativo, ou heartbeat recente) ele responde; senão,
  depois de um tempo curto sem `ack` do Hub (ex.: 30 s) *(decisão do Claude)*, a nuvem assume a mensagem. A pessoa pode
  marcar "responder pela nuvem" no assunto (ou numa mensagem). Nunca os dois respondem a mesma mensagem (o `ack` decide
  quem pegou).
- **Resposta:** busca os trechos mais próximos (pgvector), monta o contexto (trechos + histórico do assunto), pede ao
  Claude e grava a resposta **cifrada com a chave do assunto** como mensagem do executor "nuvem".
- **Documentar:** quando o Antares (na nuvem) decide gravar um documento, ele vira objeto do backup listado no
  **manifesto da nuvem** (§4.2) *(decisão do Claude: o Hub é o dono dos arquivos e do manifesto dele; dois escritores no
  mesmo manifesto dariam conflito)* e é **indexado na hora**. Quando o Hub volta, ele lê o manifesto da nuvem, incorpora
  os documentos ao manifesto dele e tira a entrada do da nuvem (contrato em `docs/hubs/space-manifest.md`).
- **Alerta de confidencialidade:** o backend entrega ao executor o **público do espaço** (quantas pessoas, papéis); o
  Antares julga o conteúdo e pergunta antes de gravar. Regra escrita no contrato do executor (vale para o Hub também).

### 4.4 Orçamento de IA
- Por organização, **mensal**, em dólares estimados (tokens do modelo × preço, embeddings, indexação), como o
  orçamento de Actions do GitHub *(unidade: decisão do Claude)*. Padrão **0** (a nuvem ativa é contratada; o financeiro
  define) *(decisão do Claude)*.
- Medição por uso (por espaço e por tipo: resposta, indexação), visível para admins da organização.
- **Avisos** a 75%, 90% e 100% (o app mostra; notificação fica para o módulo de notificações). Ao estourar: respostas e
  indexação param com erro claro (`ai-budget-exceeded`), o Hub continua funcionando normalmente.
- **Financeiro ajusta** por rota interna da plataforma (permissão nova, auditada), como a franquia de armazenamento.

## 5. Deixado para quem constrói
1. Formato do termo e das tabelas (aceites, ativação por espaço, trechos com vetor, jobs, medição, orçamento), RLS e
   índices do pgvector (HNSW/IVFFlat).
2. Chave do servidor: geração, envelope no KMS, rotação, e onde o processo a abre.
3. Serviço de embeddings no compose (imagem e versão) e no CI; cliente da Anthropic e variáveis no `.env`.
4. Bibliotecas de extração de texto por formato; tamanho de trecho e sobreposição.
5. Detecção de "Hub online" para o executor de reserva e o tempo de espera.
6. Rotas, erros, limites e rate limits.
7. Contratos novos com o Hub: manifesto do espaço, espelhos de conector no backup em nuvem ativa, incorporar documentos
   da caixa de entrada, regra de confidencialidade — escritos em `docs/hubs/` e avisados à sessão do `vaulter-hub-back`.
8. Atualizar `CLAUDE.md`, DER, `docs/app/pendencias-do-app.md` (ligar com termo, escolher "responder pela nuvem",
   avisos de orçamento, alerta de confidencialidade).

## 6. Em aberto / para depois
- Texto final do termo (Jonas, com apoio jurídico).
- Trazer documentos e gerar artefatos nas respostas.
- Executor na nuvem com ferramentas e Hub hospedado (projeto 3).
- OCR/transcrição; API de integradores na nuvem; cobrança automática.
- "Hub em software" como produto de entrada.

Perguntas que ficaram da implementação (para o Jonas):
- Texto final do termo: a v1 gravada é um **rascunho provisório**; o texto final entra como versão nova (migration) e
  exige novo aceite antes de ligar espaços novos.
- Preços reais em `AiPricing` (hoje provisórios: US$ 2/10 por milhão de tokens no Claude, US$ 0,02/MTok de custo
  nominal no embedding próprio): definem a velocidade com que o orçamento acaba.
- Id/perfil do modelo Claude no Bedrock (`CLOUD_LLM_MODEL_ID`, hoje `us.anthropic.claude-sonnet-5-5`, um palpite) e
  habilitar o acesso ao modelo na conta AWS.
- Host de produção do serviço de embeddings (o compose é só desenvolvimento; Ollama em CPU).
- Confirmar quem decide na empresa: implementado como `org.members.manage` (a permissão do kit), não `org.billing`.
- Confirmar o DELETE físico (em vez de lápide) das cópias do servidor nos assuntos (§7).
- Ler o prompt do Antares na nuvem (v1, rascunho: tom, regras, exemplos de confidencialidade) e os textos fixos do
  aviso de orçamento esgotado e da falha da resposta.

## 7. Desvios na implementação
- **Cópias da chave para o servidor apagadas de verdade** (DELETE físico) também nos assuntos, onde §4.3 diz "lápide na
  cópia do servidor": é chave que o servidor abre, nenhum feed a entrega (a lápide não serviria a ninguém) e o
  anti-objetivo pede nada legível depois de desligar.
- **Quem decide** na empresa = permissão `org.members.manage` (`org_admin` hoje); na pessoal, a própria pessoa.
- **`allow_online_llm`** é exigido ao autorizar (422 `online-llm-not-allowed`), não ligado automaticamente; o padrão é
  `true` e ainda não há rota para mudá-lo.
- **Orçamento** em micro-dólares (`bigint`, padrão 0). Autorizar exige orçamento > 0 com um erro próprio, 422
  `ai-budget-required` (0 = não contratado); `ai-budget-exceeded` é a recusa interna das tarefas (nenhuma rota HTTP a
  devolve): a indexação pausa e retoma sozinha (aumento ou mês novo), e num assunto a mensagem fica `pending` para o
  Hub com **um** aviso fixo da nuvem. Ligar (2º passo) não reconfere o orçamento. Admins com `org.billing` veem os
  valores; todo membro vê só o nível de aviso. Cada arquivo reserva o custo inteiro antes de começar (um arquivo que não
  cabe no mês não começa). O livro de uso fica depois de desligar (não é legível).
- **"Hub online"** não usa heartbeat: a mensagem é do Hub por 30 s sem `ack` a partir do `sentAt` (ou da volta à fila,
  para o Hub novo); assunto sem Hub executor é respondido na hora.
- **Assuntos criados pelo Hub** num espaço em nuvem ativa também nascem com a reserva: o Hub manda a cópia do servidor
  (rota nova `GET /hub/cloud/server-key`). Assunto antigo: **qualquer participante** liga a reserva, menos depois de o
  dono desligá-la (aí só o dono).
- **Indexação incremental** por passada do espaço guiada pelos manifestos (2 s de espera depois de cada envio ou
  apagamento), não por objeto; troca do modelo de embedding ainda sem reindexação automática. Texto extraído não é
  guardado (só trechos e o metadado do arquivo); o objeto/versão de cada trecho é o da primeira parte do arquivo.
  Embedding `nomic-embed-text:v1.5` **sem prefixo de tarefa**, como o Hub.
- **Documentos da nuvem:** um arquivo Markdown por documento, gravado só no espaço do próprio assunto ("espaço mais
  restrito" vira conselho), em nome da pessoa que confirmou (precisa poder escrever no espaço); a confirmação é
  conferida pelo servidor (a proposta estava na mensagem da nuvem logo antes). O passo 4 da incorporação (tirar do
  manifesto da nuvem o que o Hub já incorporou) roda na próxima gravação do manifesto da nuvem.
- **Chave do servidor** numa linha do banco envelopada pelo KMS, gerada no primeiro uso (rotação por `retired_at`).
- Rota extra `GET /spaces/:spaceId/cloud` (estado `off|authorized|active`, para o Gestor saber quando mandar a chave).
