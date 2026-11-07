# Papéis da plataforma — design

Data: 07/11/2026 · Status: **aprovada em 07/11/2026 (implementada)** · Repositório: `vaulter_back` (módulo novo `platform`)

Nasce de uma conversa do Jonas com o Claude. Parte da spec de produto
`../valter-valt-ai/docs/superpowers/specs/2026-10-24-organizacoes-espacos-e-nuvem-design.md` ("Papéis da plataforma
ficam separados (`platform_roles`), só no backend"), do DER `docs/der_model.sql` (`platform_roles`,
`user_platform_role`), dos módulos `identity`, `organizations` e `hubs` (padrões no `CLAUDE.md`) e da recuperação de
conta (`2026-11-07-account-recovery-design.md`), feita antes justamente para encolher o que o suporte precisa fazer.
Onde está escrito *"decisão do Claude"*, o Jonas não decidiu explicitamente.

## 1. Intenção

Dar à **equipe Vaulter** acesso controlado a operações internas, separado do que os clientes veem e fazem, **sem
nunca ganhar acesso ao conteúdo** (as chaves ficam com os clientes; nada aqui muda isso).

Quase nada do que a equipe vai fazer existe ainda (cobrança, contratos, tickets, chat). Este módulo entrega a
**estrutura** (catálogo, atribuição, trava nas rotas, auditoria) e as **duas ações de suporte** que já têm onde se
apoiar, porque resolvem situações que a recuperação pelo código não cobre:

- **Desregistro forçado de Hub:** o aparelho ficou preso numa conta que ninguém acessa (perdeu senha **e** código,
  ex-funcionário, quem vendeu o aparelho). Hoje só o dono desregistra, e sem desregistro o aparelho não pode ser
  reivindicado de novo nem depois do reset de fábrica.
- **Nomear um admin numa organização:** o único admin perdeu a conta (senha e código). Sem admin, ninguém usa o kit
  de recuperação da empresa para reabrir os espaços. O novo admin ainda precisa do kit, que só a empresa tem.

## 2. Objetivos, não objetivos e anti-objetivos

**Objetivos**
- **Papéis de fábrica** (decisão do Jonas):
  - **Administrador (`platform_admin`):** tudo, inclusive dar e tirar papéis da equipe.
  - **Financeiro (`platform_finance`):** contratos, pagamentos, comprovantes. Nasce **sem permissões**, porque
    nenhuma dessas funções existe; ganha permissões quando cada função chegar.
  - **Suporte (`platform_support`):** tickets e chat (futuros) e as duas ações de suporte acima.
- **Catálogo** de papéis e permissões da plataforma em código, semeado por migration imutável e conferido por e2e,
  como o RBAC das organizações.
- **Atribuir e retirar** papéis da equipe (só admin da plataforma), e um **comando de linha** para criar o primeiro
  admin (ninguém tem papel para dar o primeiro papel).
- **Trava nas rotas** `/platform/*`: exige token de usuário **e** a permissão da plataforma.
- **Pedidos de suporte** (desregistro forçado, nomeação de admin) com **motivo e prova** escritos, **aprovação dupla
  quando quem pede é do suporte**, e **execução imediata** depois da aprovação.
- **Auditoria** de toda ação da equipe numa trilha própria da plataforma e, quando a ação mexe numa organização, também
  na auditoria dela.

**Não objetivos (ficam para depois)**
- Tickets, chat, cobrança, contratos, comprovantes: cada um entra com as próprias permissões no catálogo.
- **Quarentena com aviso** antes da ação (decisão do Jonas: ação imediata). Pode voltar quando houver envio de e-mail.
- **E-mail de recuperação** no cadastro: entra junto com o envio de e-mail (já anotado na recuperação de conta).
- **Verificação de identidade por serviço externo** (reconhecimento facial, documento): o campo de prova aceita a
  referência de uma verificação feita fora; integrar um serviço fica para quando o volume justificar. Biometria é dado
  sensível (LGPD, art. 11) e nunca deve passar pelos nossos servidores.
- Papéis próprios da plataforma (só os de fábrica).
- Tela da equipe: o backend só entrega as rotas. Nenhuma rota daqui entra na documentação pública.
- Transferência de Hub (continua nas pendências): o caminho segue sendo desregistrar + reset + reivindicar.

**Anti-objetivos (seria fracasso mesmo funcionando)**
- Qualquer papel da plataforma abrir conteúdo de cliente, ler cópias trancadas, kits ou chaves, ou se pôr num espaço.
- Um atendente sozinho (enganado ou mal-intencionado) conseguir tirar um Hub ou pôr um admin numa empresa.
- Ação da equipe sem rastro, ou com rastro que o cliente afetado não consegue ver.
- Papel da plataforma vazar para o Hub ou para o app do cliente (não entra na sincronização nem no `GET /me` de
  cliente; ver §4.2).

## 3. Restrições

- Monólito modular: módulo novo `platform` com `domain`/`application`/`infra`. **Dependência em uma direção só:**
  `platform -> identity, organizations, hubs`, apenas pelo que eles exportam da `application/`. Nenhum deles importa
  `platform`. As duas ações exigem **operações novas exportadas** por `hubs` e `organizations` (ver §4.4), que
  recebem a autorização já feita (como o `trusted` do `SpaceRoomService`).
- Tabelas do DER: `platform_roles`, `user_platform_role`; o catálogo de permissões da plataforma é novo (tabelas a
  desenhar pelo builder no estilo de `permissions`/`role_permission`, ou só em código se o builder justificar).
- `platform_*` não tem `organization_id`, não sincroniza com Hub e não tem RLS por organização; o runtime lê o catálogo
  só com `SELECT` (GRANT), como o catálogo RBAC. Atribuições e pedidos o runtime grava (`INSERT/UPDATE`, sem `DELETE`).
- Toda ação sensível da equipe exige **reautenticação** (`currentAuthProof`, `@ThrottleReauth()`).
- Ids, datas, erros RFC 9457, paginação por cursor, sem nome do produto em código/tabelas/rotas: como o resto.

## 4. Como funciona

### 4.1 Catálogo (decisão do Claude nas permissões; papéis do Jonas)
Permissões iniciais:
- `platform.roles.manage` — atribuir/retirar papéis da plataforma.
- `platform.support.request` — abrir pedido de suporte (desregistro forçado, nomeação de admin).
- `platform.support.approve` — aprovar/recusar pedido de outra pessoa.
- `platform.support.execute_alone` — abrir e executar na hora, sem segunda aprovação.
- `platform.audit.read` — ler a auditoria da plataforma e consultar pedidos.

Papéis:
- `platform_admin`: todas.
- `platform_support`: `platform.support.request`, `platform.audit.read` (só os próprios pedidos *(decisão do Claude;
  o builder pode abrir para todos os pedidos se achar melhor)*).
- `platform_finance`: nenhuma.

### 4.2 Quem é da equipe
- Uma pessoa da equipe usa uma **conta normal** do `identity` com um papel da plataforma por cima (`user_platform_role`).
- A trava das rotas `/platform/*` confere token de usuário e a permissão, lendo as atribuições **no banco a cada
  requisição** (retirar o papel vale na hora, como a revogação de sessão). Sem papel: **404** nas rotas da plataforma
  (não revela que elas existem) *(decisão do Claude)*.
- O papel da plataforma não aparece em nenhuma resposta de cliente nem na sincronização. Uma rota própria
  (`GET /platform/me`) diz ao app/tela da equipe quais permissões a pessoa tem.
- **Primeiro admin:** comando de linha (`npm run platform:grant-admin -- <email>`), rodado com o login dono do banco
  (`DB_USERNAME`), idempotente, auditado. É o único jeito de criar admin sem já ser admin.
- Retirar o próprio papel de admin quando é o **último admin** da plataforma: recusado (`last-platform-admin`, 422).

### 4.3 Pedidos de suporte (decisão do Jonas: imediato + aprovação dupla para o suporte; detalhes do Claude)
Um pedido tem: tipo (`hub_force_deregister` | `org_appoint_admin`), alvo, **motivo** (texto obrigatório),
**prova** (texto obrigatório: o que foi conferido e as referências, ex.: "NF 4567, CPF confere, verificação externa
nº 123"), quem pediu, estado e quem aprovou/recusou.

- **Quem pede tem `platform.support.execute_alone` (admin):** o pedido é criado já **aprovado e executado** na mesma
  transação.
- **Quem pede não tem (suporte):** o pedido nasce **pendente**. Outra pessoa com `platform.support.approve` aprova
  (executa na hora) ou recusa (com motivo). **Quem pediu nunca aprova o próprio pedido** (`self-approval`, 422).
- Pedido pendente vence em 7 dias sem decisão (vira `expired`) *(decisão do Claude)*.
- Quem pediu perde `platform.support.request` (papel retirado): na mesma transação da retirada, os pedidos pendentes
  dele viram `rejected` sem decisor, com nota `requester_lost_permission` (auditado `platform.request.rejected` com
  `metadata.reason`); a decisão reconfere isso sob o lock do pedido e responde 409 `support-request-not-pending`
  *(decisão do Claude, revisão final)*.
- Execução falhou (ex.: o Hub já foi desregistrado pelo dono, a conta-alvo sumiu): o pedido fica `failed` com o
  `type` do erro, e nada muda no alvo.
- Pedir, aprovar e recusar exigem reautenticação.
- Estados: `pending`, `executed`, `rejected`, `expired`, `failed`.

### 4.4 As duas ações
**Desregistro forçado de Hub (`hub_force_deregister`, alvo `hubId`)**
- Efeito **idêntico** ao desregistro feito pelo dono (`DeregisterHubUseCase`: lápide no Hub, vínculos, espaços, papéis,
  Sala cai em toda organização já vinculada, troca de chave pendente). O `hubs` exporta uma operação que executa isso
  sem exigir que o chamador seja o dono (a autorização é do `platform`), reaproveitando o mesmo código e a mesma ordem
  de locks.
- Auditoria do `hubs` como hoje (`hub.deregistered` na organização pessoal do dono, e o que a cascata grava em cada
  organização vinculada, como a revogação do vínculo e a queda da Sala), **todas** com `metadata` marcando que foi a
  plataforma e o id do pedido. A operação exportada recebe essa origem e a leva até cada gravação: quem sente o efeito
  são as organizações vinculadas, não o dono que perdeu a conta. *(decisão do Claude)*
- O dono legítimo faz o reset de fábrica e reivindica de novo com a conta nova. O Vaulter nunca recebe conteúdo.

**Nomear admin (`org_appoint_admin`, alvo `organizationId` + `userId` do novo admin)**
- O novo admin pode ser **membro atual** ou **qualquer conta cadastrada** (vira membro e admin). Vale **mesmo havendo
  admins**: a conta perdida continua ativa no banco, e o motivo registra que ela está inacessível (decisão do Jonas,
  na conversa).
- **Organização pessoal: recusado** (`personal-organization-protected`, 422).
- **Ninguém da equipe pode ser o nomeado** (decisão do Jonas): conta com qualquer papel da plataforma (inclusive quem
  pede ou aprova) é recusada como alvo, na criação **e de novo na aprovação/execução** (o alvo pode ter ganhado papel
  depois do pedido). Erro próprio (ex.: `staff-cannot-be-appointed`, 422). Se alguém da equipe precisar entrar numa
  empresa, a empresa convida pelo fluxo normal.
- O `organizations` exporta uma operação que dá `org_admin` (criando o vínculo se preciso), com o
  `lockMembershipContext` de hoje, e audita `member.role_changed` / `member.joined` com `metadata` marcando a
  plataforma e o id do pedido. Visível para os admins da organização.
- O novo admin remove a conta perdida pelo fluxo normal, se quiser. A ação **não** mexe em espaços nem em chaves: para
  reabrir espaços órfãos, ele usa o kit da empresa (fluxo atual).

### 4.5 Auditoria da plataforma
- Trilha própria (`platform_audit_logs`, *append-only*: runtime só `INSERT/SELECT`), com quem fez, ação, alvo, id do
  pedido, resultado e `metadata` sem segredo. Ações: `platform.role.granted|revoked`, `platform.request.created|
  approved|rejected|executed|failed|expired` *(nomes: decisão do Claude)*, e `platform.lookup.user|hub|organization`
  (toda busca da equipe, achando ou não: alvo achado ou `metadata.found = false`; nunca o e-mail procurado) *(revisão
  final)*.
- Ação que mexe numa organização também vai para o `audit_logs` dela (§4.4), para o cliente ver o que a equipe fez.
  Nessas linhas, `user_id` fica **nulo** e a `metadata` leva `{ actor: 'platform', supportRequestId }`: a conta pessoal
  de quem da equipe agiu não é exposta ao cliente (ela fica na trilha da plataforma). *(decisão do Claude)*
- Hoje **nenhuma rota de cliente lê** o `audit_logs`. Este módulo grava o rastro; a leitura pelo cliente (rota/tela de
  auditoria da organização) fica para depois (§6). O anti-objetivo "rastro que o cliente consegue ver" fica atendido
  no dado, não ainda na tela. *(decisão do Claude)*

### 4.6 Rotas (forma; nomes finais com o builder)
- `GET /platform/me` — permissões da pessoa.
- `GET /platform/staff`, `PUT /platform/staff/:userId/roles/:roleKey`, `DELETE ...` — papéis (`platform.roles.manage`).
- `POST /platform/support-requests`, `GET /platform/support-requests` (cursor, filtro por estado),
  `GET /platform/support-requests/:id`, `POST /platform/support-requests/:id/approve`, `.../reject`.
- `GET /platform/audit` (cursor).
- Para o suporte achar o alvo: busca de conta por e-mail e consulta mínima de Hub/organização (id, nome, dono, status,
  sem nada cifrado) *(decisão do Claude; o builder decide o mínimo necessário)*.
- Rate limit: o `default` por IP, mais o orçamento `reauth` nas rotas que pedem a senha.

## 5. Deixado para quem constrói
1. Tabelas do catálogo de permissões e de pedidos; migration imutável do catálogo e e2e banco == código.
2. Nomes exatos de rotas, campos, `type` dos erros e das ações de auditoria.
3. As operações exportadas por `hubs` e `organizations` (nome, contrato), sem que eles importem `platform`, e o
   contexto de RLS que cada uma usa por dentro.
4. Como o vencimento de 7 dias acontece (na leitura, ou por tarefa do pg-boss).
5. O comando `platform:grant-admin` (script compilado como o CLI do TypeORM, ou caso de uso chamado por um script).
6. Atualizar `CLAUDE.md` (módulo novo, rotas, limites), o DER (`.sql` e `.mwb`) e `docs/hubs/hub-lifecycle.md` (o
   desregistro forçado como saída para Hub preso).

## 6. Em aberto / para depois
- Quarentena com aviso e e-mail de recuperação, quando houver envio de e-mail.
- Endurecer a aprovação dupla quando a equipe crescer (dois admins diferentes, sem exceção para admin).
- Integração com serviço de verificação de identidade (guardar só o resultado e o número, nunca a imagem).
- Permissões do financeiro, tickets e chat.
- Rota/tela para os admins da organização lerem o `audit_logs` (inclusive as ações da plataforma).
- A conta perdida que segue como admin/membro: limpeza por iniciativa da equipe (hoje fica com o novo admin).
