# Módulo `spaces` — design

Data: 25/10/2026 · Status: **aguardando aprovação do Jonas** · Repositório: `vaulter_back`

Nasce de uma conversa do Jonas com o Claude. Parte da spec de produto
`../valter-valt-ai/docs/superpowers/specs/2026-10-24-organizacoes-espacos-e-nuvem-design.md` (§3, §4.1, §5, §6, §7),
do DER `docs/der_model.sql` (`spaces`, `space_keys`, `space_key_grants`, `role_assignments`) e dos módulos
`identity` e `organizations` (padrões no `CLAUDE.md`). Onde está escrito *"decisão do Claude"*, o Jonas não
decidiu explicitamente.

## 1. Intenção

O espaço é o **cérebro de uma área da organização**. Ali ficam documentos, manuais, decisões, planejamentos,
memórias e o índice do RAG. Exemplos: "Manuais", "Financeiro", "Diretoria". Cada espaço é cifrado com a própria
chave, e só lê quem tem uma cópia dela trancada para si.

O backend **não lê nada**. Ele guarda as cópias trancadas da chave, os papéis e as versões da chave, e
coordena quem precisa trancar o quê para quem. O conteúdo (arquivos, RAG, backup no S3) chega depois, no
módulo de storage.

## 2. Objetivos, não objetivos e anti-objetivos

**Objetivos**
- Criar, renomear e listar espaços de uma organização.
- Pôr e tirar pessoas de um espaço, com papel: Leitor, Editor ou Gestor.
- Guardar as **cópias trancadas** da chave do espaço por pessoa e para o kit de recuperação.
- **Trocar a chave** (nova versão) quando alguém sai, sem tocar no conteúdo.
- Coordenar as **pendências de trancar**: um app de dentro precisa trancar a chave para alguém, gerar uma
  versão nova ou retrancar para um kit novo.
- **Convite que já indica espaços:** a organização convida a pessoa e diz em quais espaços ela vai entrar;
  quem está dentro confirma e tranca depois.

**Não objetivos (ficam para depois)**
- Conteúdo, upload, backup no S3 e RAG (módulo de storage). Nuvem ativa (`active_cloud`): o campo existe, mas
  só `encrypted_backup` é aceito.
- Hubs, cópias trancadas para Hubs, "liberado na sala", e as permissões de modelo online por espaço (o campo
  `allow_online_llm` existe e vale `true`).
- Instalações de app (API de integração).
- Excluir espaço.

**Anti-objetivos (se acontecer, falhou mesmo funcionando)**
- O backend, ou um admin que não está no espaço, conseguir ler o conteúdo ou se pôr sozinho num espaço.
- Quem saiu do espaço ou da organização continuar recebendo cópias da chave **nova**.
- Um espaço ficar sem nenhuma cópia para o kit de recuperação (não teria como reabrir se todos saírem).
- Um membro que não é da organização aparecer num espaço.

## 3. Decisões do Jonas

- **Quem cria já fica dentro**, como **Gestor**, e lê tudo. É o caso mais comum: o admin do escritório cria e
  já está lá.
- **Saiu, perdeu o acesso.** O espaço é da organização; o conteúdo **não** é apagado nem mexido. Coisas pessoais
  vão para a organização pessoal, num Hub próprio.
- **Troca de chave na saída:** gera-se uma versão nova da chave, usada só no que for escrito dali em diante. O
  antigo não é recifrado na v1.
- O kit de recuperação nasce no primeiro espaço (decidido no módulo `organizations`).

## 4. Modelo

- **`spaces`** (DER): `organization_id`, `name`, `cloud_mode` (só `encrypted_backup`), `allow_online_llm`
  (`true`) e `current_key_version`. É sincronizável.
- **`space_keys`** (DER): uma linha por versão (`space_id`, `version`, `recovery_wrapped_key`). É sincronizável.
  - **Kit de cada versão (decisão do Claude):** coluna nova `recovery_key_fingerprint`, com o hash da
    `recovery_public_key` usada para trancar aquela versão.
    - O app manda junto a chave pública do kit que usou, e o backend confere que é o kit **atual** da organização.
      Senão responde 409 `recovery-key-changed`, para o app recarregar.
    - Assim o backend sabe exatamente quais versões ainda estão no kit antigo. A pendência "retrancar para o kit"
      é calculada a partir disso, sem flag manual, e uma troca de kit no meio de outra operação não deixa versão
      perdida.
  - **Retrancar:** `recovery_wrapped_key` é **sobrescrita**. Não precisa de lápide, porque é uma coluna de uma linha
    sincronizável: o `sync_version` sobe e os Hubs recebem a cópia nova. Isso substitui, neste módulo, a frase da
    spec de `organizations` de que "as cópias para o kit antigo viram lápide".
  - **Quem pode retrancar:** qualquer membro que tenha cópia de todas as versões (todo membro tem; veja "Pôr alguém").
- **`space_key_grants`** (DER): cópia trancada por pessoa (`space_key_id`, `user_id`, `wrapped_key`). As colunas
  `hub_id` e `app_installation_id` já nascem nulas, para os módulos seguintes. É sincronizável. Remover é lápide.
- **Membro do espaço:** é uma atribuição em `role_assignments` com `scope_type = 'space'`, `space_id` e um papel
  de espaço (`space_reader`, `space_editor`, `space_manager`, do catálogo existente). Isso exige estender o RLS de
  `role_assignments` (hoje só por organização). As linhas de espaço também levam `organization_id`, para o
  isolamento continuar por organização (decisão do Claude).
- **Ter `memory.read` anda junto com ter cópia da chave** da versão atual (spec §4.1). O backend garante isso
  nas operações: pôr alguém exige a cópia e tirar alguém tira a cópia.

## 5. Formato da cópia trancada (decisão do Claude)

Segue o formato v1 de `docs/crypto/user-keys.md`, que ganha uma seção:

- **Chave do espaço:** 32 bytes aleatórios, gerados no app de quem cria ou de quem troca a versão.
- **Cópia trancada para alguém:** `0x01 ‖ crypto_box_seal(chaveDoEspaço, publicKeyDoDestinatário)`, ou seja,
  1 + 48 + 32 = **81 bytes**, em base64url sem padding. O destinatário é a `public_key` X25519 do usuário ou a
  `recovery_public_key` da organização.
- **Validação no backend:** só formato, tamanho e byte de versão. Ele **não** consegue checar se a cópia abre.
  Quem garante isso é o app.

## 6. Fluxos

**Criar espaço** (`org.spaces.create`, só admin pelos papéis de fábrica)
- **Kit primeiro:** se a organização ainda não tem kit, o app gera o kit primeiro e registra com o endpoint de
  kit existente (reautenticação; o kit é mostrado uma vez).
- **No app:** gera a chave e manda `name`, a cópia para si e a cópia para o kit (versão 1).
- **No backend,** numa transação só:
  - cria o espaço e a versão 1;
  - grava a cópia de quem criou;
  - atribui `space_manager` a quem criou;
  - audita `space.created`.
- **Sem kit:** criar sem kit registrado responde 422 `recovery-key-required`.

**Pôr alguém no espaço** (`space.members.manage` no espaço, ou seja, o Gestor)
- **Todas as versões, não só a atual (decisão do Claude):** o espaço é o cérebro da área, e quem entra precisa ler
  também o que foi escrito antes das trocas de chave.
- **No app do Gestor:** pega a `publicKey` da pessoa pela lista de membros da organização, tranca a chave de **cada
  versão existente** e manda `userId`, `roleKey` e `grants: [{ version, wrappedKey }]`.
- **No backend:**
  - confere que a pessoa é membro ativo da organização e que a lista cobre exatamente todas as versões
    (`key-versions-mismatch`, 409, para o app recarregar);
  - grava a cópia (limpa a lápide se a pessoa já esteve lá);
  - atribui o papel;
  - audita `space.member_added`.
- **Admin fora do espaço:** um admin da organização que não está no espaço **não** consegue pôr ninguém, nem a si
  mesmo, porque não tem a permissão no espaço nem a chave.

**Trocar o papel** (Gestor): Leitor ↔ Editor ↔ Gestor. O espaço precisa manter **pelo menos um Gestor**, salvo
quando a pessoa sai da organização (abaixo).

**Tirar alguém ou sair do espaço** (Gestor tira; qualquer membro sai)
- **No backend:**
  - grava lápide no papel e nas cópias dessa pessoa (todas as versões, para o Hub apagar a cópia local);
  - marca o espaço como **"troca de chave pendente"**;
  - audita.
- **Último Gestor:** o último Gestor não pode sair nem ser rebaixado enquanto houver outros membros
  (`last-space-manager`).

**Saída da organização** (já existe no `organizations`)
- Remover alguém da organização, ou a pessoa sair dela, também tira a pessoa **de todos os espaços** daquela
  organização, na mesma transação. Cada espaço afetado fica com troca pendente.
- Isso pode deixar um espaço **sem Gestor**, ou até **órfão** (sem ninguém). São dois casos (decisão do Claude):
  - **Sem Gestor, mas com membros:** um admin da organização pode **promover um membro que já está no espaço**
    a Gestor (`POST /spaces/:id/managers`), sem kit nenhum. Ele não se põe no espaço e não lê nada. Fica auditado.
  - **Órfão (nenhum membro ativo):** um admin reabre pelo kit de recuperação (`POST /spaces/:id/recover`).
    - O app abre as cópias do kit com a parte secreta, tranca **todas as versões** para o próprio admin e manda
      `grants: [{ version, wrappedKey }]` e `currentAuthProof` (reautenticação, como na troca do kit).
    - O backend só aceita com o espaço sem nenhum membro ativo (`space-not-orphan`, 409). O admin entra como Gestor.
    - Fica auditado como `space.recovered_with_kit`, que é o aviso aos administradores até existir canal de
      notificação (spec §3).
  - Essa é a **única** exceção à regra "o admin não se põe sozinho num espaço", e só existe porque, sem ela, o
    espaço ficaria perdido para sempre.
- O `organizations` não pode importar o `spaces` (a dependência é no sentido contrário): ele chama um gancho,
  `MemberRemovedHooks`, no padrão dos ganchos de cadastro, e o `spaces` se inscreve.

**Trocar a chave (nova versão)** (qualquer membro com cópia da chave atual; o app faz em segundo plano)
- **No app:** vê a pendência, gera a chave nova e manda: `version` = atual + 1, uma cópia para **cada membro
  ativo** do espaço e a cópia para o kit atual da organização.
- **No backend:**
  - recusa se a lista de cópias não bater exatamente com os membros ativos, ou se a versão não for a seguinte
    (`key-rotation-mismatch`, 409, para o app recarregar e tentar de novo);
  - grava a versão nova e as cópias;
  - atualiza `current_key_version`;
  - limpa a pendência;
  - audita `space.key_rotated`.
- **Versões antigas:** continuam válidas para ler o conteúdo antigo.

**Retrancar para um kit novo** (pendente quando a organização troca o kit)
- **Kit trocado:** o `organizations` já registra a troca. O `spaces` marca cada espaço com
  **"retrancar para o kit pendente"**.
- **No app de um membro (com confirmação humana, decisão do Jonas no módulo `organizations`):** depois de a pessoa
  confirmar "Ana trocou o kit da organização em tal data. Confirmar?", o app manda a cópia da chave **de cada
  versão** trancada para o kit novo.
- **No backend:** troca as `recovery_wrapped_key` e limpa a pendência.
- **Escopo do backend:** ele só aceita isso de um membro do espaço e só para o kit **atual** da organização. A
  confirmação humana é tela do app.

**Pessoa entra na organização com espaços indicados no convite**
- **No convite:** o convite da organização ganha `spaces: [{ spaceId, roleKey }]` opcional. Só pode indicar um
  espaço quem é Gestor dele.
- **No aceite:** o backend cria uma **pendência de trancar** por espaço indicado (pessoa, espaço, papel, quem
  indicou), e a pessoa ainda **não** está no espaço.
- **Pendência:** aparece no app dos Gestores do espaço. Um deles tranca a chave e a pessoa entra, pelo mesmo fluxo
  de "pôr alguém". Também é possível recusar.
- **Expiração:** a pendência some sozinha se a pessoa sair da organização.

## 7. API (rotas internas do app, sem a tag `public`)

| Método e rota | O que faz | Quem pode |
|---|---|---|
| `GET /organizations/:orgId/spaces` | espaços da organização **em que eu estou** (com meu papel e as pendências que me cabem), por cursor | membro da org |
| `POST /organizations/:orgId/spaces` | cria (`name`, `wrappedKey`, `recoveryWrappedKey`) | `org.spaces.create` |
| `GET /spaces/:id` | detalhes, versão atual, flags de pendência | membro do espaço |
| `PATCH /spaces/:id` | renomeia | Gestor |
| `GET /spaces/:id/members` | membros e papéis (com `publicKey`) | membro do espaço |
| `POST /spaces/:id/members` | põe alguém (`userId`, `roleKey`, `grants[]` com todas as versões) | Gestor |
| `PATCH /spaces/:id/members/:userId` | troca o papel | Gestor |
| `DELETE /spaces/:id/members/:userId` | tira alguém | Gestor |
| `POST /spaces/:id/leave` | sai | membro do espaço |
| `GET /spaces/:id/keys` | minhas cópias trancadas (todas as versões) e a versão atual | membro do espaço |
| `POST /spaces/:id/keys` | nova versão (`version`, `grants[]`, `recoveryWrappedKey`) | membro com a chave atual |
| `PUT /spaces/:id/keys/recovery` | retranca todas as versões para o kit atual (`versions[]`) | membro do espaço |
| `POST /spaces/:id/managers` | admin promove um membro existente a Gestor quando o espaço ficou sem Gestor | admin da org |
| `POST /spaces/:id/recover` | admin reabre um espaço órfão pelo kit (`grants[]`, `currentAuthProof`) | admin da org |
| `GET /spaces/:id/pending-grants` | pendências de trancar (pessoas indicadas por convite) | Gestor |
| `DELETE /spaces/:id/pending-grants/:id` | recusa a pendência | Gestor |

O convite (`POST /organizations/:id/invitations`) ganha `spaces` opcional.

- **Não membro:** espaço de que não sou membro, ou de outra organização, responde **404**. O admin da organização
  que não está no espaço também recebe 404 nos detalhes (decisão do Claude: ele gerencia a organização, não o
  espaço).
- **Lista do admin:** um admin que quer ver **quais** espaços existem na organização (sem ler) usa
  `GET /organizations/:orgId/spaces?all=true`, que devolve só nome, número de membros e data, com `org.spaces.create`
  (decisão do Claude, spec §3: "vê quanto cada espaço ocupa").

## 8. Restrições técnicas

- **Padrões do `CLAUDE.md`:**
  - unit of work em toda mutação;
  - `OrganizationAccess` para a organização e um `SpaceAccess` equivalente para o espaço (404 para não membro do
    espaço, 403 para quem não tem a permissão), exportado para os próximos módulos;
  - RLS sem `SECURITY DEFINER`;
  - migrations novas, sem editar as aplicadas;
  - `migration:generate` vazio (o CI já confere);
  - `problem+json`, cursor, `camelCase`.
- **Isolamento:** `spaces`, `space_keys` e `space_key_grants` levam RLS. As duas tabelas de chave não têm
  `organization_id` no DER, então a policy usa `EXISTS` no espaço, ou recebe `organization_id` desnormalizado
  (decisão do builder, testada pelo papel de runtime).
  - O 404 uniforme vale **entre organizações**: um `spaceId` de outra organização (ou inexistente) responde 404 em
    toda rota, inclusive na intenção de espaço do convite. **Dentro da própria organização**, quem convida
    indicando um espaço de que não é Gestor recebe **403** (não vaza nada: o admin já lista os espaços com
    `?all=true`).
- **Limites (nenhum espaço pode ficar travado):**
  - **membros:** no máximo `SPACE_MAX_MEMBERS = 500` membros ativos por espaço (constante do domínio). A troca de
    chave manda uma cópia por membro num pedido só, então pôr o 501º (inclusive ao atender uma pendência de
    convite) responde 409 `space-member-limit`; o limite de cópias do DTO da troca vem da mesma constante
    (500 × ~175 bytes ≈ 88 kB). A reabertura pelo kit só acontece com zero membros;
  - **versões:** pôr membro, retrancar para o kit e reabrir pelo kit mandam **todas as versões num pedido só**, e
    isso cresce com as versões (cada saída do espaço = uma troca = uma versão). O DTO aceita até 500 versões
    (500 × ~142 bytes ≈ 71 kB, abaixo do limite padrão de 100 kB do corpo JSON). A versão da troca nunca tem
    teto. Quando algum espaço se aproximar: aumentar o limite do corpo JSON nessas rotas, ou aceitar as versões
    em lotes por faixa de versão.
- **Sincronizáveis:** `spaces`, `space_keys` e `space_key_grants` levam `sync_version`. Remover é lápide.
- **Pendências:** as flags ("troca de chave pendente", "retrancar para o kit pendente") e as pendências de
  trancar por convite são estado **do backend**. Não sincronizam e nunca carregam material de chave.
- **DER:** as mudanças entram no `.sql` e no `.mwb`: `organization_id` em `role_assignments` usado no escopo
  espaço, `space_keys.recovery_key_fingerprint`, a flag de troca de chave pendente e a tabela de pendências de
  trancar.
- **Rate limit:** `POST /spaces/:id/recover` usa o mesmo limite de reautenticação por usuário de
  `PUT /me/password` e da troca do kit (`@ThrottleReauth`).

## 9. Fica a cargo de quem construir

- A forma das flags de pendência (colunas em `spaces` ou tabela própria) e da tabela de pendências de trancar
  por convite.
- O desenho exato das policies de RLS das tabelas de chave.
- Os nomes dos ganchos de saída da organização e a ordem das operações na transação.
- Os rate limits das rotas novas (o padrão global basta, salvo justificativa).
- A ordem das tarefas e como fatiar os commits.
