# Recuperação de conta pelo código de recuperação — design

Data: 07/11/2026 · Status: **aprovada em 07/11/2026** · Repositório: `vaulter_back` (módulo `identity`)

Nasce de uma conversa do Jonas com o Claude, que começou nos papéis da plataforma e mudou de rumo: antes de decidir
o que o suporte faz, era preciso resolver o que acontece quando alguém esquece a senha. Parte do formato das chaves
do usuário (`docs/crypto/user-keys.md`) e do módulo `identity` (padrões no `CLAUDE.md`). Onde está escrito
*"decisão do Claude"*, o Jonas não decidiu explicitamente.

## 1. Intenção

Hoje, esquecer a senha é perder a conta: a chave privada X25519 do usuário só abre com uma chave derivada da senha,
e toda cópia de chave de espaço (em todas as organizações) é trancada para a chave pública dele. Uma empresa que
usa o Hub por anos e perde a senha do único admin perde a gestão de tudo; uma pessoa sozinha perde os dados.

A recuperação pelo **código de recuperação pessoal** resolve isso sem quebrar a promessa de que nem o Vaulter lê o
conteúdo: no cadastro, o app gera um código aleatório, tranca com ele **uma segunda cópia da mesma chave privada** e
manda ao servidor só essa cópia trancada e uma prova de posse. Quem perde a senha e tem o código abre a chave
privada, define uma senha nova e volta a ser **a mesma conta** (mesmas organizações, papéis, espaços e Hubs). Nada
precisa ser retrancado, porque o par de chaves não muda. Mesmo modelo do kit de emergência do 1Password e do código
de recuperação do Bitwarden.

**Por que não o kit da organização** (ideia descartada na conversa): o kit é por organização e fica com a empresa,
não com a pessoa. Quem está em várias organizações recuperaria só onde tem o kit, e nas outras cada espaço
precisaria de alguém para retrancar as cópias para uma chave nova. O kit da organização continua fazendo o que já
faz (reabrir espaços órfãos da empresa).

## 2. Objetivos, não objetivos e anti-objetivos

**Objetivos**
- **Código obrigatório no cadastro** (decisão do Jonas): toda conta nasce com recuperação. Não existe o estado
  "conta sem código".
- **Recuperar a conta** só com e-mail + código (decisão do Jonas: sem e-mail por enquanto), definindo senha nova e
  mantendo o mesmo par de chaves.
- **Trocar o código** (gerar um novo, pedindo a senha atual); o antigo deixa de valer na hora.
- Atualizar `docs/crypto/user-keys.md` com o formato v1 do código e dos blobs, com vetor de teste, como contrato
  para o app.

**Não objetivos (ficam para depois)**
- **Confirmação por e-mail** na recuperação (código + link no e-mail). Anotado para quando precisarmos de mais
  segurança: protege contra quem achar o código guardado. Exige montar envio de e-mail, que o backend ainda não tem.
- Avisar a pessoa (e-mail, notificação) quando a conta for recuperada ou o código trocado.
- Papéis da plataforma e ações do suporte (desregistro forçado de Hub, nomear admin em organização que ficou sem
  nenhum): próximo projeto, com o desenho desta recuperação já em mãos.
- Recuperação "esqueci a senha" por e-mail que devolva só o login (sem os dados) — ver §6.
- Tela e fluxo do app (mostrar o código, confirmar que foi guardado): é do app; este projeto só define o contrato.

**Anti-objetivos (seria fracasso mesmo funcionando)**
- O servidor conseguir abrir a chave privada ou ver o código. O código nunca sai do aparelho; o servidor vê só a
  prova (e guarda só um hash dela) e a cópia trancada.
- A rota de recuperação virar **oráculo**: dizer se o e-mail existe, se a conta tem código ou por que falhou.
- A cópia trancada pelo código vazar por outro caminho: resposta de `GET /me`, sincronização do Hub, logs, Sentry.
- Quem só tem acesso ao e-mail (ou a uma sessão roubada sem a senha) conseguir trocar o código ou tomar a conta.

## 3. Restrições

- Mesma cripto do resto: libsodium, primeiro byte de versão em todo blob, base64url sem padding, rótulos de
  contexto sem o nome do produto.
- Ainda não há usuários em produção, o banco de desenvolvimento tem **zero** usuários (conferido em 07/11/2026) e
  nenhum cliente chama `/auth/register` ainda (`vaulter-hub-app` e `vaulter-hub-back` conferidos). Por isso o corte é
  **direto**: colunas `NOT NULL`, campos obrigatórios no cadastro, sem janela de transição. Quem tiver contas num
  banco local zera o banco (procedimento no `CLAUDE.md`).
- A troca de senha atual continua igual: a mesma chave privada é retrancada pela senha nova e a cópia pelo código
  continua válida (o código não muda quando a senha muda).
- Login offline no Hub não muda: ele continua usando `kdfSalt`/`kdfParams`/`encryptedPrivateKey` da senha, que
  chegam pela sincronização depois de uma recuperação, como depois de uma troca de senha.

## 4. Como funciona

### 4.1 Cripto (formato v1, a detalhar em `docs/crypto/user-keys.md`)
- **Código:** 32 bytes aleatórios (`randombytes_buf(32)`), 256 bits. Como mostrar à pessoa (palavras, grupos de
  caracteres) é decisão do app; o contrato com o backend é sobre os 32 bytes. *(decisão do Claude)*
- Do código saem duas subchaves com `crypto_kdf_derive_from_key(32, id, "<contexto de 8 bytes>", codigo)`, contexto
  próprio diferente de `"acctkeys"` (ex.: `"acctrcvy"`) *(decisão do Claude)*:
  - `id = 1`: **`recoveryProof`** (vai ao servidor);
  - `id = 2`: **chave de cifra da recuperação** (nunca sai do aparelho).
  Sem Argon2id: o código tem 256 bits de entropia, não precisa de derivação lenta. *(decisão do Claude)*
- **`recoveryEncryptedPrivateKey`**: mesma construção do `encryptedPrivateKey` (73 bytes: `0x01 ‖ nonce ‖
  XChaCha20-Poly1305(privateKey)`), com a chave de cifra da recuperação. O dado associado deve diferenciar os dois
  blobs para um não passar pelo outro. *(decisão do Claude; o builder fixa o valor no `user-keys.md`)*
- **No servidor:** guarda a cópia trancada e um **hash com chave** da `recoveryProof` (BLAKE2b com uma chave do
  `.env`, como o `HUB_CODE_HASH_KEY`), comparado em tempo constante. Como a prova tem 256 bits, não precisa de
  Argon2id nem do pool. *(decisão do Claude; o builder pode preferir reaproveitar o hasher existente se achar
  melhor, desde que não exponha o pool a um ataque de custo.)*

### 4.2 Cadastro
`POST /auth/register` passa a exigir `recoveryProof` e `recoveryEncryptedPrivateKey`. Sem eles: 422. O resto do
cadastro não muda.

### 4.3 Recuperar a conta (público, dois passos, sem estado no servidor) *(decisão do Claude)*
1. **Buscar a cópia:** a pessoa informa e-mail e código. O app manda `{ email, recoveryProof }`. Prova certa:
   o servidor devolve `recoveryEncryptedPrivateKey`. Qualquer falha (e-mail inexistente, prova errada, malformada)
   é **o mesmo erro** (`recovery-failed`, 401 ou 422 — o builder escolhe, coerente com o login) com tempo uniforme.
2. **Concluir:** o app abre a chave privada, gera o material da senha nova (`kdfSalt`, `kdfParams`, `authProof`,
   `encryptedPrivateKey`, igual à troca de senha) e manda `{ email, recoveryProof, ...material novo, device }`. O
   servidor confere a prova de novo, grava a senha nova, **revoga todas as sessões** do usuário e devolve uma sessão
   nova para esse aparelho (mesma resposta do login).
- O passo 2 confere a prova sozinho (não depende de o passo 1 ter acontecido).
- O código **continua o mesmo** depois da recuperação; o app deve sugerir gerar um novo logo em seguida (§4.4).
  *(decisão do Claude: trocar o código no passo 2 obrigaria a pessoa a guardar outro código num momento de
  estresse; fica como recomendação do app.)*
- O servidor não consegue conferir se o `encryptedPrivateKey` novo guarda a mesma chave privada (não abre nada):
  um app com defeito poderia trancar a chave errada e travar a conta. Risco aceito, igual ao da troca de senha; o
  app deve abrir o blob novo antes de enviar.

### 4.4 Trocar o código
Rota autenticada (ex.: `PUT /me/recovery-code`) com `currentAuthProof`, `recoveryProof` nova e
`recoveryEncryptedPrivateKey` nova. Exige reautenticação, então entra no orçamento compartilhado `@ThrottleReauth()`.
O código antigo deixa de valer na hora. Não revoga sessões. *(decisão do Claude)*

### 4.5 Limites e vazamento
- As duas rotas públicas de recuperação dividem um contador (`THROTTLE_GROUPS`), por IP **e** por e-mail
  normalizado, como o login (ex.: 10/min por IP e 5/min por e-mail). *(decisão do Claude; o builder ajusta os
  números.)* A prova tem 256 bits, então o limite é contra abuso, não contra adivinhação.
- `recoveryProof`, `recoveryEncryptedPrivateKey` e o hash entram na limpeza do pino e do `beforeSend` do Sentry.
- **Registro:** recuperação concluída e troca de código ficam só no **log estruturado** (com `userId` e
  `requestId`, sem prova nem blob). Sem `audit_logs` por enquanto: a auditoria é por organização e gravar em cada
  organização da pessoa exigiria um gancho novo do `identity` (como `RegistrationHooks`). Vai junto com o aviso
  por e-mail (§6). *(decisão do Claude)*
- Nunca saem em `GET /me`, na sincronização do Hub (`hub-sync.sql-reader.ts` lista colunas explicitamente; manter
  assim) nem em nenhuma outra resposta, além do passo 1.

## 5. Deixado para quem constrói
1. Nomes exatos das rotas, dos campos e do `type` dos erros, seguindo as convenções do `CLAUDE.md`.
2. Valor do dado associado de cada blob e do contexto de 8 bytes, e o vetor de teste no `user-keys.md`.
3. Status HTTP do erro único de recuperação (coerente com o login).
4. Colunas novas em `users` (ou tabela própria), `NOT NULL` (§3), constraints nos metadados da entidade, migration
   e `schema:check`, ajustando fixtures e helpers de teste (`test/support/`) para cadastrar com código.
5. A chave do hash com chave (`.env`, validada no boot, documentada na tabela de variáveis e em "Rotação de
   segredos": trocar a chave invalida todos os códigos, então na prática não se troca sem um plano).
6. Atualizar `CLAUDE.md` (módulo `identity`, rate limit, variáveis) e o helper de cripto do cliente de teste.

## 6. Em aberto / para depois
- **Confirmação por e-mail** na recuperação (pedido do Jonas, para quando precisarmos de mais segurança).
- **Aviso** de recuperação ou troca de código (precisa do mesmo envio de e-mail) e **auditoria visível** para os
  admins das organizações da pessoa (gancho do `identity` + ações novas em `audit_logs`).
- Quem perdeu senha **e** código: na organização pessoal, perde tudo; nas empresas, os outros membros e o kit da
  organização salvam os espaços. O `user-keys.md` já fala de uma "recuperação de senha por e-mail" que devolveria
  só o login; ela deixa de ser necessária com esta recuperação e o trecho deve ser reescrito.
- **Papéis da plataforma**, logo em seguida: o suporte faria desregistro forçado de Hub (aparelho preso numa
  conta perdida) e nomearia admin em organização que ficou sem nenhum, sem ganhar acesso a conteúdo.
