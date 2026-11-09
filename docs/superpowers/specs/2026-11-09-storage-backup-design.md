# Storage e backup cifrado no S3 — design

Data: 09/11/2026 · Status: **aprovada em 09/11/2026 (implementada)** · Repositório: `vaulter_back` (módulo novo `storage`)

Nasce de uma conversa do Jonas com o Claude. Parte da spec de produto
`../valter-valt-ai/docs/superpowers/specs/2026-10-24-organizacoes-espacos-e-nuvem-design.md` (§6 modo de nuvem por
espaço, §7 decisões desde a v1), do módulo `hubs` (`docs/hubs/hub-lifecycle.md`) e do `spaces`. Onde está escrito
*"decisão do Claude"*, o Jonas não decidiu explicitamente.

## 1. Intenção

O **backup cifrado é obrigatório** para todo espaço (spec de produto §6): ninguém perde o cérebro do Hub. Além de
seguro, ele é o jeito de **a alma (a conta) encontrar um corpo (o Hub)**: um Hub novo ou trocado baixa e abre os dados
pela sincronização normal, sem fluxo especial de "restaurar". O Vaulter guarda e nunca lê.

E o Hub funciona **como um console de videogame** (decisão do Jonas): cada espaço tem um tamanho reservado, pôr um espaço
no Hub é "instalar" (precisa caber no SSD), tirar é "desinstalar" (os dados continuam no backup e voltam ao reinstalar).

## 2. Objetivos, não objetivos e anti-objetivos

**Objetivos**
- **Enviar:** o Hub envia as mudanças dos espaços **a cada 5 minutos**, junto com a sincronização (decisão do Jonas: no
  pior caso, um Hub queimado perde ~5 min). Os bytes vão **direto para o S3** por URL assinada; o backend mantém o
  **índice** dos objetos de cada espaço.
- **Baixar:** o Hub baixa os espaços da **Sala** com o token do Hub; um **membro do espaço** baixa os espaços dele com o
  token dele (é assim que o Hub, com a pessoa logada online, traz a "alma" dela).
- **Quem envia:** o Hub, com o próprio token nos espaços em que é editor na Sala, ou com o token da pessoa logada nos
  espaços em que ela pode escrever (§4.2).
- **Restaurar = reinstalar:** reivindicar o Hub novo, pôr os espaços, baixar. Sem rota especial.
- **Lixeira de 30 dias** (decisão do Jonas): arquivo apagado ou versão antiga continua recuperável por 30 dias, depois
  some de vez.
- **Tamanho por espaço:** definido na criação (**padrão 10 GB**, decisão do Jonas), sem teto artificial no Hub (cabe o
  que couber no SSD).
- **Franquia de nuvem por organização:** a soma dos tamanhos reservados dos espaços de uma organização não passa da
  franquia (**padrão 50 GB**, pessoal ou empresa, decisão do Jonas). Espaço grande só com franquia maior (decisão do
  Jonas: o backup continua obrigatório; não existe espaço "só no Hub").
- **Capacidade do Hub:** o Hub informa quanto do SSD pode usar; instalar um espaço só se a soma dos tamanhos reservados
  dos espaços instalados couber.
- **Financeiro ajusta a franquia** (decisão do Jonas): primeira permissão do papel `platform_finance`,
  `platform.billing.storage_quota`, numa rota interna auditada.
- **Trava prevista:** enquanto o espaço tem `keyRotationRequired`, nenhum envio novo é aceito.
- **Fechar o buraco do login no Hub:** só faz login num Hub quem tem papel nele (decisão do Jonas na conversa; ver §4.7).

**Não objetivos (ficam para depois)**
- **Snapshot** (restaurar o espaço inteiro como estava numa data, guarda mais longa): **serviço pago** futuro. O índice
  com versões por objeto já permite, sem mudar formato.
- **Contratação pela própria organização** da franquia, com cobrança automática: o campo da franquia é o mesmo; muda
  quem o ajusta.
- **Classes de armazenamento mais baratas** (acesso infrequente/Glacier) para espaços grandes ou antigos.
- **Nuvem ativa** (`active_cloud`: o backend lê e indexa): continua só o campo.
- **App enviando ou mostrando conteúdo:** na v1 só o Hub envia; o app não mostra conteúdo.
- **Visitante** (pessoa logando num Hub que não é dela nem das organizações dela): ideia para depois, com aviso claro.
- **Configuração inicial do Hub pelo app via Bluetooth** (no lugar do código falado, resolvendo o idioma para vendas no
  exterior): projeto do Hub + app; para o backend o código de reivindicação só deixa de ser falado.
- Exportar ou apagar tudo de um cliente pelo prefixo (LGPD), excluir espaço: pendências já conhecidas.

**Anti-objetivos (seria fracasso mesmo funcionando)**
- O Vaulter conseguir ler qualquer conteúdo, **inclusive nomes de arquivos**: o índice no backend só tem ids, tamanhos,
  hashes e versões (o Hub guarda o próprio manifesto como um objeto cifrado).
- Conteúdo novo cifrado com uma versão da chave que quem saiu do espaço conhece.
- Quem não é membro do espaço (nem Hub da Sala dele) conseguir baixar ou enviar, ou descobrir se um espaço existe.
- Cliente estourando a franquia sem perceber, ou o backend ficar no caminho dos bytes (custo e latência).
- Perder dados por limpeza automática fora da lixeira de 30 dias.

## 3. Restrições

- Bucket único `S3_BUCKET_HUB_BRAIN` (LocalStack em dev, `us-east-1` em produção, versionado), caminho
  `orgs/<orgId>/spaces/<spaceId>/objects/<objectId>`. Nome do bucket só no `.env`.
- Módulo novo `storage` depende de `spaces` (`SpaceAccess`, estado do espaço), `organizations` (franquia) e `hubs`
  (token de Hub, Sala, capacidade) só pelo que eles exportam. Ninguém importa `storage`.
- Tabelas novas com `organization_id` e **RLS por organização**, timestamps e lápides como o resto. O índice é dado de
  cliente; não entra na sincronização do Hub por `sync_version` na v1 (o Hub lista pelo próprio endpoint de índice).
- Runtime sem `DELETE`: a limpeza física do índice após a lixeira é uma rotina com o login dono (ver §5).
- SDK oficial da AWS para S3 (`@aws-sdk/client-s3` + presigner), configurável para LocalStack (`AWS_ENDPOINT_URL`,
  `S3_FORCE_PATH_STYLE`). Nenhum segredo de AWS em código.

## 4. Como funciona

### 4.1 Formato do objeto (contrato com o Hub; a detalhar em `docs/crypto/space-backup.md`)
- Cada objeto é um blob cifrado pelo Hub com a chave do espaço: byte de versão `0x01` ‖ nonce ‖ XChaCha20-Poly1305,
  com dado associado que amarra o objeto ao espaço, ao `objectId` e à versão da chave (sem o nome do produto).
- O `objectId` (UUID v7) é gerado pelo Hub e estável: atualizar um arquivo é uma **nova versão do mesmo objeto**.
- O índice registra, por versão: `objectId`, `keyVersion`, `sizeBytes`, `sha256` do blob cifrado, `s3VersionId`,
  quem enviou, quando. Nada de nome, tipo ou caminho em claro *(decisão do Claude)*.
- O que entra no backup (documentos, índice RAG, conversas, eventos; sem espelho de conector) é decisão do Hub, como na
  spec de produto §10.

### 4.2 Enviar *(fluxo: decisão do Claude)*
**Quem envia** *(decisão do Claude, depois da revisão)*: conteúdo só nasce de quem escreve, então:
- o **Hub com o próprio token**, nos espaços em que ele está na **Sala com papel `space_editor`** (conteúdo que o Hub
  cria sozinho: conversas, eventos, índice);
- o **Hub em nome da pessoa logada** (token de usuário da sessão aberta pelo Hub, §4.7), nos espaços em que ela pode
  escrever (`space_editor`/`space_manager`).
Hub da Sala só com `space_reader` não envia; o índice derivado é regenerado ao restaurar.

1. **Intenção de envio:** o Hub pede `{ spaceId, objectId, keyVersion, sizeBytes, sha256, replacesVersionId | null }`.
   O backend confere: quem envia pode escrever (acima); `keyRotationRequired` falso (senão 409
   `space-key-rotation-required`); `keyVersion` igual à versão atual do espaço (409 `space-key-version-stale`); uso +
   `sizeBytes` ≤ tamanho do espaço (422 `space-storage-full`, com quanto falta); `sizeBytes` ≤ 5 GB por objeto (o Hub
   divide arquivos maiores). Devolve uma **URL assinada de PUT** (validade curta, ex.: 15 min) presa ao tamanho e ao
   checksum declarados, num **prefixo provisório** (`orgs/<orgId>/spaces/<spaceId>/uploads/<uploadId>`).
2. O Hub manda os bytes **direto para o S3**.
3. **Confirmação:** o Hub confirma; o backend faz `HEAD` no provisório, confere tamanho e checksum, **copia dentro do
   S3** para `objects/<objectId>` (sem os bytes passarem pelo backend) e grava a versão no índice (a anterior vira versão
   antiga, na lixeira). Envio nunca confirmado fica só no prefixo provisório, que expira em 1 dia: nunca sobrescreve uma
   versão boa *(decisão do Claude, depois da revisão)*.
- **Concorrência entre Hubs** *(decisão do Claude)*: `replacesVersionId` diz qual versão o envio substitui (nulo para
  objeto novo). Se a versão atual já é outra (outro Hub gravou antes), a confirmação dá 409 `object-version-conflict` e
  o Hub resolve (ex.: grava como cópia de conflito, objeto novo). Vale também para o manifesto.
- **Troca de chave pendente** (decisão do Jonas: opção "a" agora, "b" depois): enquanto o espaço tem
  `keyRotationRequired`, o backend recusa envios; o **Hub guarda as mudanças numa fila local** e envia tudo depois que um
  membro fizer a troca pelo app. O app deve avisar os membros com insistência ("troca de chave pendente"). Num Hub
  queimado nesse intervalo, perde-se o que estava na fila (limite aceito). **Evolução prevista ("b"):** o Hub editor da
  Sala faz a troca sozinho (ele tem a chave e conhece as chaves públicas dos membros e do kit pela sincronização), para
  o backup nunca parar.
- Lote: a intenção e a confirmação aceitam vários objetos por pedido (o Hub envia o que mudou a cada 5 min) *(o builder
  fixa o tamanho do lote)*.
- **Apagar:** o Hub manda a lápide do objeto; o backend grava lápide no índice e um *delete marker* no S3. O objeto fica
  na lixeira 30 dias. **Quem apaga** *(decisão da revisão final)*: os mesmos que enviam (`memory.write`: Hub editor da
  Sala com o próprio token, pessoa `space_editor`/`space_manager`), porque um editor já apagaria o conteúdo
  substituindo-o (a versão antiga vai do mesmo jeito para a lixeira) e, sem isso, o que o Hub criou e apagou voltaria
  vivo numa restauração.
- Na v1 só o **Hub** envia (com o próprio token ou com o da pessoa logada nele); o app não envia.

### 4.3 Baixar
- **Listar o índice** de um espaço por cursor (objetos vivos com a versão atual; filtros para lixeira e versões
  antigas), com `since` para o Hub pegar só o que mudou.
- **URL assinada de GET** de uma versão específica.
- Quem pode: Hub com o espaço na Sala (token de Hub) **ou** membro do espaço (token de usuário). Quem não pode: 404 sem
  revelar o espaço (`SpaceAccess`).
- **Lixeira:** listar o que foi apagado ou substituído nos últimos 30 dias e baixar aquela versão. Restaurar é o Hub
  reenviar o conteúdo como versão nova *(decisão do Claude: sem "desapagar" no servidor)*.

### 4.4 Tamanho do espaço e franquia da organização
- Espaço novo nasce com `storageQuotaBytes` (padrão 10 GB; quem cria pode escolher outro na criação).
- **Mudar o tamanho:** o Gestor do espaço *(decisão do Claude)*. Aumentar exige caber na franquia da organização **e**
  na capacidade de cada Hub onde o espaço está instalado; diminuir só até o uso atual (lixeira inclusa).
- **Franquia da organização** (`storageQuotaBytes` na organização, padrão 50 GB por variável de ambiente): a soma dos
  tamanhos reservados dos espaços vivos não passa dela. Criar ou aumentar além do que sobra: 422
  `organization-storage-quota-exceeded`, dizendo quanto sobra.
- **Uso** de um espaço = soma do tamanho de todas as versões guardadas (vivas, antigas e na lixeira).
- `GET` do espaço e da organização mostram reservado, usado e livre.

### 4.5 Capacidade do Hub e instalar
- O Hub informa a **capacidade utilizável do SSD** (`PUT /hub/storage` com token de Hub) na autenticação e quando mudar.
- **Instalar** (`hub_space`, rota que já existe): só se a soma dos `storageQuotaBytes` dos espaços instalados neste Hub
  (todas as organizações) + o novo ≤ capacidade; senão 422 `hub-storage-full` com quanto falta. Hub que ainda não
  informou capacidade: sem conferência *(decisão do Claude, para não travar Hub com software antigo)*.
- `GET /hubs/:id` mostra capacidade, reservado e livre.
- Desinstalar não apaga nada na nuvem.

### 4.6 Franquia pelo financeiro
- Permissão nova `platform.billing.storage_quota` para `platform_finance` e `platform_admin` (migration nova do
  catálogo da plataforma; o catálogo é imutável por migration).
- `PUT /platform/organizations/:orgId/storage-quota` com o novo valor, motivo e reautenticação; não pode ficar abaixo do
  total já reservado. Auditado na trilha da plataforma e no `audit_logs` da organização (`user_id` nulo, ator
  plataforma, como as outras ações da equipe).

### 4.7 Login no Hub só de quem tem papel nele *(forma: decisão do Claude)*
- Hoje o login online no Hub é o `/auth/login` comum com `device.platform = 'hub'`, e o backend não confere o Hub.
- Novo: o Hub faz o login da pessoa por uma rota com **token de Hub** (ex.: `POST /hub/user-sessions`), que recusa
  quem não tem papel naquele Hub (`hub_owner`, `hub_operator`, `hub_user` explícito ou implícito) com o **mesmo erro**
  de credencial inválida (sem oráculo). `/auth/login` passa a recusar `device.platform = 'hub'`.
- O Hub também confere localmente (ele conhece os membros pela sincronização); o backend é a segunda trava.
- **A sessão aberta pelo Hub fica presa a ele** (`user_sessions` guarda o `hubId`) e é revogada quando a pessoa perde o
  papel no Hub, quando a organização que dava o papel é desvinculada ou quando o Hub é desregistrado (ganchos do
  `hubs`) *(decisão do Claude, depois da revisão)*.
- O download com token de usuário (§4.3) vale para qualquer sessão de um membro do espaço (inclusive celular, no
  futuro): ele já tem a chave do espaço; o conteúdo continua cifrado.

### 4.9 Dados que já existem *(decisão do Claude)*
- Não há produção. Na migration, todo espaço ganha 10 GB e toda organização 50 GB; organização que já nasce acima da
  franquia só fica impedida de reservar mais (nada é bloqueado ou apagado).
- Hub que informa capacidade menor que o já reservado (SSD trocado): aceito; só novas instalações são recusadas.

### 4.8 Lixeira e limpeza
- **S3:** regra de ciclo de vida no bucket: versões antigas e *delete markers* em `objects/` expiram em **30 dias**;
  tudo em `uploads/` (provisório) expira em 1 dia. A regra fica no script do LocalStack e documentada para produção.
- **Índice:** versões fora da lixeira saem do índice por uma rotina (pg-boss) com o login dono, alinhada ao S3, e o uso
  do espaço é recalculado.

## 5. Deixado para quem constrói
1. Nomes exatos de rotas, campos, erros; tamanho do lote; validade das URLs.
2. Tabelas do índice (objeto e versões), colunas de tamanho/franquia/capacidade, RLS, migrations e DER.
3. Como manter o "uso" de cada espaço (contador atualizado na confirmação e na limpeza, ou soma na hora).
4. A rotina de limpeza (pg-boss) e como ela roda com o login dono.
5. O formato exato do blob em `docs/crypto/space-backup.md`, com vetor de teste, e o helper de cripto do Hub nos testes.
6. e2e contra o LocalStack do compose (o CI precisa de um serviço LocalStack ou equivalente).
7. Atualizar `CLAUDE.md`, `docs/hubs/hub-lifecycle.md` (envio, instalação/capacidade, login pelo Hub) e o DER.

## 6. Em aberto / para depois
- Snapshot pago; contratação de franquia pela organização com cobrança; classes de armazenamento mais baratas.
- Troca de chave feita pelo próprio Hub editor da Sala (opção "b"), para o backup nunca parar.
- Visitante em Hub alheio; configuração inicial por Bluetooth e idioma do Hub.
- Nuvem ativa; envio pelo app; exportar/apagar organização pelo prefixo; excluir espaço.
- Avisar a organização perto da franquia (precisa de notificação/e-mail).
