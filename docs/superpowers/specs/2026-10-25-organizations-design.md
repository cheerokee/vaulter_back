# Módulo `organizations` — design

Data: 25/10/2026 · Status: **aguardando aprovação do Jonas** · Repositório: `vaulter_back`

Nasce de uma conversa do Jonas com o Claude. Parte da spec de produto
`../valter-valt-ai/docs/superpowers/specs/2026-10-24-organizacoes-espacos-e-nuvem-design.md` (§3, §4, §4.1, §5, §7.2)
e do DER `docs/der_model.sql`, e segue o módulo de referência `identity` (CLAUDE.md). Onde está escrito
*"decisão do Claude"*, o Jonas não decidiu explicitamente.

## 1. Intenção

Hoje o backend tem usuários e sessões, mas ninguém pertence a nada. Este módulo cria **quem contrata**: a
organização, os membros e os papéis. Ele é a base para espaços, Hubs e cobrança.

O produto atende dois públicos com **uma estrutura só**:
- o **escritório com muita gente**, que é o primeiro cliente pagante esperado;
- a **pessoa sozinha**, que é uma organização de uma pessoa só.

A pessoa sozinha não pode ganhar telas ou passos a mais.

## 2. Objetivos, não objetivos e anti-objetivos

**Objetivos**
- Organização com nome, política de vínculo de Hubs, plano e kit de recuperação.
- **Organização pessoal** criada no cadastro, sem tela extra.
- Membros entram por **convite por link** (no cadastro ou já logados), saem, são removidos e trocam de papel.
- Catálogo de permissões e papéis de fábrica (RBAC com escopo, spec §4.1) gravado como dado, e atribuições no
  **escopo de organização** funcionando.
- **Assentos:** a contagem de membros fica pronta para a cobrança, com limite conferido no convite e no aceite.

**Não objetivos (ficam para depois)**
- Excluir uma organização: exige apagar backups no S3 e avisar os Hubs vinculados (decisão do Jonas).
- Espaços, Hubs, vínculo Hub ↔ organização, atribuições nos escopos de espaço e de Hub, e papéis próprios
  (modo avançado).
- Cobrança de verdade e medição de uso de IA, que vão para o módulo do roteador de IA (seção 8).
- Envio de e-mail. O backend gera o link e o app compartilha por onde quiser (e-mail, WhatsApp...).
- Avisar os administradores por e-mail ou push. Nesta etapa o aviso é um registro no `audit_logs`, e o canal
  vem depois.

**Anti-objetivos (se acontecer, falhou mesmo funcionando)**
- Alguém ver ou alterar dados de uma organização da qual não é membro.
- Um link de convite vazado dar **leitura** de algum espaço. Ele pode no máximo pôr alguém na organização.
- O servidor, ou um administrador sozinho, conseguir obter a parte secreta do kit de recuperação.
- O cadastro da pessoa sozinha ganhar uma etapa nova.

## 3. Organização e organização pessoal

- **Campos:** `organizations` segue o DER: `name`, `is_personal`, `hub_link_policy`
  (`any_member_hub` | `admin_approved`, padrão `any_member_hub`), `plan` (padrão `free`), `recovery_public_key`
  e `sync_version`.
- **Mudança no DER:** `recovery_public_key` passa a aceitar **nulo**. A organização nasce sem kit, e o kit é
  registrado quando ela passar a precisar dele (seção 5).
- **Cadastro:** o `POST /auth/register` cria a organização pessoal **na mesma operação** do usuário.
  - O nome padrão é o nome do usuário; o app pode trocar depois.
  - A pessoa vira Administradora dela.
  - A organização tem `is_personal = true`.
- **Organização pessoal:**
  - não pode ser excluída (exclusão nem existe nesta etapa);
  - **pode receber membros e crescer para um time sem migração** (spec §3);
  - o dono não pode sair dela;
  - toda conta tem **exatamente uma** organização pessoal.
- **Dono da organização pessoal (decisão do Claude):**
  - coluna nova `personal_owner_user_id` (nula nas organizações comuns), com índice único parcial, o que garante
    "exatamente uma por conta" no banco;
  - o dono **não pode ser removido nem rebaixado** por outros administradores, mesmo depois de a organização
    crescer para um time.
- **Organizações a mais:** qualquer usuário logado cria uma e vira Administrador dela.

## 4. Membros e convites

**Fluxo (decisão do Jonas):** quem convida gera um **link** e o app manda por onde quiser.
- Quem **não tem conta** abre o link, se cadastra, e o vínculo acontece **na mesma operação do cadastro**.
- Quem **já tem conta** abre o link, faz login e **aceita**.
- **Aceitar já põe a pessoa na organização**, sem confirmação de quem convidou (decisão do Jonas).

**Segurança do convite:**
- **Segredo e hash:** o link carrega um segredo aleatório de 32 bytes, e o banco guarda **só o hash**, como no
  refresh token do `identity`.
- **Uso:** uso único, validade de **7 dias** (decisão do Claude) e revogável por quem pode convidar.
- **Morre com a permissão de quem convidou:** ao ser removido, sair ou ser rebaixado de `org_admin`, os convites
  pendentes que a pessoa criou são revogados na mesma transação (auditado `invitation.revoked` com
  `reason: creator_lost_permission`); a prévia e o aceite também reconferem que o criador ainda é membro ativo
  com `org.members.manage`. Sem isso, um admin removido voltaria pelo próprio link.
- **E-mail opcional:** se o convite tiver e-mail, só aceita uma conta com esse e-mail, normalizado. Enquanto não
  houver confirmação de e-mail, isso protege pouco, porque qualquer um cadastra o e-mail de outra pessoa. Por
  isso o limite real de dano é a regra abaixo.
- **Espaços não vêm pelo link.** A leitura de um espaço exige que alguém **de dentro** tranque a chave do espaço
  para a pessoa nova, com a chave pública que só existe depois do cadastro. O link vazado põe um estranho na
  organização, mas ele não lê nada.
- **Intenção de espaços (fica para o módulo de espaços):** o convite poderá registrar em quais espaços e com qual
  papel a pessoa vai entrar. O pedido de trancar a chave aparece depois no app de quem está dentro. O formato
  do convite deve permitir acrescentar isso sem migração destrutiva.

**Tabela nova `organization_invitations`** (não está no DER; entra no `.sql` e no `.mwb`). Ela **não** é
sincronizável e não tem `sync_version`.

| Coluna | Conteúdo |
|---|---|
| `id` | uuid |
| `organization_id` | organização do convite |
| `token_hash` | hash do segredo do link |
| `email` | nulo quando o convite não exige e-mail |
| `role_id` | papel de organização que a pessoa vai receber |
| `status` | `pending`, `accepted`, `revoked` ou `expired` |
| `expires_at` | fim da validade |
| `created_by_user_id` | quem convidou |
| `accepted_by_user_id` / `accepted_at` | quem aceitou e quando |
| `created_at` / `updated_at` / `deleted_at` | timestamps de toda tabela |

O RLS é por `organization_id`.

**Regras dos membros:**
- **Vínculo:** `user_organization` segue o DER. Sair ou ser removido grava `deleted_at` (lápide), e voltar limpa a
  lápide, sem linha nova. O que a pessoa registrou continua nos espaços.
- **Papéis:** trocar o papel de um membro é mudar a atribuição de papel de organização.
- **Último administrador:** a organização sempre mantém **pelo menos um administrador** com `org.members.manage`.
  Remover, rebaixar ou sair que deixaria a organização sem nenhum é recusado.
- **Assentos (seção 8):**
  - o assento é o membro ativo, e o convite pendente **não** ocupa assento (decisão do Claude);
  - o limite vem do plano e é conferido ao **criar** e ao **aceitar** o convite;
  - por enquanto todo plano é ilimitado.

## 5. Kit de recuperação da organização

Modelo da spec §5: a parte secreta é gerada **no aparelho**, mostrada uma vez e **nunca** chega ao servidor. O
servidor guarda só `recovery_public_key`.

- **Quando nasce (decisão do Jonas):** não no cadastro. O kit é gerado quando a organização passa a precisar dele.
  Isso acontece quando o primeiro espaço é criado, no módulo de espaços. Também pode acontecer por uma ação
  explícita do administrador. Este módulo oferece o endpoint para registrar ou substituir a chave pública.
- **Não dá para rever o kit, só substituir (decisão do Jonas):**
  - um administrador gera um kit novo quantas vezes quiser, como as chaves privadas de outros sistemas;
  - antes, o app avisa que o kit atual deixa de valer e só segue com a confirmação;
  - a ação fica numa **área de ações destrutivas, em vermelho** (tela do app);
  - o kit novo aparece uma única vez.
- **No backend, ao substituir:**
  - a chave pública nova entra no lugar da antiga;
  - o evento é registrado no `audit_logs`, que serve de aviso aos outros administradores até existir um canal de
    notificação;
  - o retrancamento das chaves dos espaços para o kit novo é feito pelo app de quem está dentro de cada espaço,
    e as cópias para o kit antigo viram lápide. Essa parte nasce no módulo de espaços. Aqui só fica registrado
    que o kit mudou.
- **Quem pode:** só administradores (`org.members.manage`). Quem tem o kit lê tudo, então essa ação é sensível.
- **Duas travas contra troca indevida da chave (decisão do Claude):**
  - **Reautenticação:** o `PUT` exige `currentAuthProof` (a prova da senha, como na troca de senha), então uma
    sessão roubada sozinha não troca o kit. Prova errada responde 422 `current-auth-proof-invalid`.
  - **Confirmação humana no retrancamento:** fica para o módulo de espaços, mas o desenho nasce aqui. O app de
    quem está dentro **só retranca para um kit novo depois de a pessoa confirmar** ("Ana trocou o kit da
    organização em tal data. Confirmar?"). Assim, nem um servidor comprometido que troque a chave no banco
    consegue a leitura sozinho.
- **Formato:** a `recovery_public_key` é X25519 crua, de 32 bytes, em base64url sem padding. É o mesmo formato
  da `public_key` do usuário (`docs/crypto/user-keys.md`). O backend valida formato e tamanho.

## 6. Papéis e permissões (RBAC)

**Catálogo de fábrica**, gravado por migration como dado imutável (spec §4.1):
- todas as permissões dos três escopos;
- os papéis de fábrica com `organization_id` nulo e `key` fixa.

Nesta etapa só as atribuições no **escopo de organização** são usadas. As de espaço e de Hub vêm nos módulos
deles, sem mudar o banco.

| Escopo | Papel (`key`) | Permissões (decisão do Claude, revisável) |
|---|---|---|
| Organização | Administrador (`org_admin`) | `org.members.manage`, `org.spaces.create`, `org.hubs.approve`, `org.billing` |
| Organização | Membro (`org_member`) | nenhuma de organização (entra nos espaços por convite) |
| Espaço | Leitor (`space_reader`) | `memory.read` |
| Espaço | Editor (`space_editor`) | `memory.read`, `memory.write` |
| Espaço | Gestor (`space_manager`) | `memory.read`, `memory.write`, `memory.delete`, `space.members.manage` |
| Hub | Dono (`hub_owner`) | todas as de Hub |
| Hub | Operador (`hub_operator`) | `chat.voice`, `chat.live`, `camera.view`, `camera.live`, `nodes.view`, `nodes.control`, `mesh.dispatch` |
| Hub | Usuário (`hub_user`) | `chat.voice`, `chat.live`, `nodes.view` |
| Hub | Sala (`hub_room`) | `chat.voice` |

**Dependências entre permissões (DER `permission_dependency`):** `camera.live` → `camera.view` e
`nodes.control` → `nodes.view`.

**Checagem:** a pergunta é sempre "este usuário tem a permissão X neste escopo?". Ela vira um serviço
exportado pela `application/` do módulo, porque os próximos módulos vão perguntar a mesma coisa.

## 7. API (rotas internas do app, sem a tag `public`)

| Método e rota | O que faz | Quem pode |
|---|---|---|
| `GET /organizations` | minhas organizações (com meu papel), por cursor | logado |
| `POST /organizations` | cria organização (eu viro admin) | logado |
| `GET /organizations/:id` | detalhes | membro |
| `PATCH /organizations/:id` | nome, `hubLinkPolicy` | admin |
| `PUT /organizations/:id/recovery-key` | registra ou substitui a `recoveryPublicKey` (registra no audit) | admin |
| `GET /organizations/:id/members` | membros e papéis, por cursor | membro |
| `PATCH /organizations/:id/members/:userId` | troca o papel (admin ↔ membro) | admin |
| `DELETE /organizations/:id/members/:userId` | remove (lápide) | admin |
| `POST /organizations/:id/leave` | sai | membro, exceto na pessoal |
| `POST /organizations/:id/invitations` | cria convite e devolve **o link (segredo) uma vez** | admin |
| `GET /organizations/:id/invitations` | convites pendentes (sem segredo) | admin |
| `DELETE /organizations/:id/invitations/:invitationId` | revoga | admin |
| `POST /invitations/preview` | corpo `{ token }`: prévia pública do convite (nome da organização, quem convidou, validade) | público, com rate limit |
| `POST /invitations/accept` | corpo `{ token }`: aceita estando logado; responde `{ organizationId, roleKey }` | logado, com rate limit |
| `POST /auth/register` | ganha `inviteToken` opcional; cria a organização pessoal e, se houver convite válido, o vínculo, tudo na mesma transação | público |

- **Token no corpo, nunca na URL:** a URL aparece nos logs de requisição e no Sentry; por isso prévia e aceite recebem o `token` no corpo (formato inválido dá 422 de validação; bem formado mas sem valor dá `invitation-invalid`).
- **Cadastro com convite inválido (decisão do Claude):** o cadastro **segue**. A conta e a organização pessoal são
  criadas, sem o vínculo, e a resposta informa `invitation: { accepted: false }`, para o app avisar "o convite não
  valia mais". Bloquear o cadastro por causa de um link velho trava quem só quer criar a conta.
- **Dados expostos (decisão do Claude):**
  - a lista de membros mostra a cada membro: nome, e-mail, papel, data de entrada e `publicKey` (pública por
    natureza, e o módulo de espaços vai precisar dela para trancar chaves);
  - a prévia pública do convite mostra **só** o nome da organização, o **nome** de quem convidou e a validade.
    Nenhum e-mail aparece ali, porque o link pode vazar.
- **Resposta para quem não é membro:** pedir uma organização da qual não se é membro responde **404**, para não
  revelar que ela existe.
- **Ação de admin sem permissão:** feita por um membro comum, responde **403**.
- **Convite inválido, expirado, revogado ou já usado:** dá o mesmo erro estável (`invitation-invalid`), sem dizer
  qual dos casos é.
- **Rate limit:** a prévia e o aceite de convite entram na tabela de limites (padrão a definir no plano, por IP).

## 8. Assentos e cobrança (direção, não construção)

Modelo **híbrido** (decisão do Jonas: o escritório com muita gente vem primeiro, mas o individual tem que
funcionar):
- o plano é da organização: **N assentos** (membros com login) mais uma **franquia de IA da organização inteira**
  que cresce com os assentos;
- a **Sala e os Hubs consomem da franquia** da organização dona do espaço consultado, sem ocupar assento;
- a pessoa sozinha é a mesma estrutura, com 1 assento;
- o OpenRouter **não** entra nessa conta: na opção "chave própria", o cliente paga direto (`modelo-de-negocio.md`).
  Os termos comuns do OpenRouter proíbem revender acesso.

Este módulo entrega só a contagem de assentos e o ponto de checagem do limite. A medição de uso por evento
(organização, usuário ou Sala, Hub, espaço, modelo, tokens, custo, **nunca conteúdo**), a franquia e o que
acontece quando ela acaba ficam para o módulo do roteador de IA.

## 9. Restrições técnicas

- **Padrões de `CLAUDE.md`:** camadas, contratos como classes abstratas, `problem+json`, cursor, `camelCase`,
  UUID v7, migrations com `down` e metadados que deixam o `migration:generate` vazio.
- **Organização como contexto:** as tabelas com `organization_id` usam `enableOrganizationRls` e o repositório
  base exige a organização (`OrganizationScopedRepository`).
- **Listar as organizações de um usuário** atravessa organizações. O RLS precisa de uma forma segura de permitir
  isso, por exemplo uma policy adicional ligada ao usuário do contexto. A escolha é do builder, mas o resultado
  não pode abrir dados de organização para quem não é membro, e precisa de teste pelo papel de runtime.
- **Cadastro atômico:** usuário, sessão, organização pessoal, atribuição de admin e aceite de convite são
  gravados **numa transação só**. O `identity` hoje grava cada repositório separado. Este trabalho precisa de um
  jeito de transação entre repositórios (e entre módulos) que respeite as fronteiras: o `identity` chama o que o
  `organizations` exporta da `application/`, sem tocar na `infra/` dele.
- **Sincronizáveis:** `organizations`, `user_organization`, `permissions`, `permission_dependency`, `roles`,
  `role_permission` e `role_assignments` levam `sync_version` (trigger). Remover é sempre lápide.
- **Tabelas que apontam para o futuro (decisão do Claude):** `role_assignments` e `audit_logs` nascem **completas,
  como no DER**, com as colunas de espaço, Hub e instalação de app já criadas e nulas. As FKs para `spaces`,
  `hubs` e `app_installations` entram nas migrations desses módulos. Assim a promessa "sem mudar o banco" vale.
- **`audit_logs` nasce aqui (decisão do Claude):**
  - tabela do DER, só de acréscimo, com RLS por organização;
  - um serviço exportado pela `application/` para os outros módulos gravarem;
  - eventos desta etapa: troca do kit, entrada (aceite de convite), saída, remoção, troca de papel, e criação e
    revogação de convite.
- **DER:** as mudanças (`recovery_public_key` nula, `personal_owner_user_id`, `organization_invitations`) entram no
  `.sql` **e** no `.mwb`. O `.mwb` é um zip com XML, e o módulo `identity` já mostrou que dá para editá-lo e
  validá-lo no Workbench.

## 10. Fica a cargo de quem construir

- O mecanismo de transação entre repositórios (unit of work) e onde ele mora em `shared/`.
- A forma exata da policy de RLS para "minhas organizações".
- O formato do link (rota do app ou deep link) e a codificação do segredo, seguindo o padrão do refresh token.
- Os números de rate limit da prévia e do aceite de convite.
- A ordem das tarefas e como fatiar os commits.
