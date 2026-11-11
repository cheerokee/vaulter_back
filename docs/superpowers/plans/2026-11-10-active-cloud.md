# Nuvem ativa — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Espaços em nuvem ativa (opção contratada, com termo de aceite) que a nuvem indexa a partir do backup cifrado e onde o Antares responde pelo app com o Hub fora de alcance, documenta pela conversa com alerta de confidencialidade, sob um orçamento mensal de IA por organização.

**Architecture:** Módulo novo `src/cloud/` com portas para chave do servidor (KMS), embeddings (`nomic-embed-text`) e modelo de linguagem (Claude no Bedrock), tarefas no pg-boss (que entra agora), índice no pgvector com RLS. `spaces`, `storage` e `conversations` ganham o mínimo para a nuvem: cópia da chave para o servidor, gancho de envio confirmado e executor "nuvem". Contratos novos com o Hub (manifesto do espaço) documentados em `docs/hubs/`.

**Tech Stack:** NestJS 12, TypeScript 6 (ESM), TypeORM 1.x + Postgres 18 + pgvector, pg-boss, `@aws-sdk/client-kms`, `@aws-sdk/client-bedrock-runtime`, LocalStack 4.14.0 (S3 + KMS), um serviço de embeddings no compose, libsodium, Vitest + supertest.

**Spec:** `docs/superpowers/specs/2026-11-10-active-cloud-design.md` (autoridade).

## Global Constraints

- Docs pt-BR; código/logs/commits em inglês (Conventional Commits). Tudo na `develop`; push depois de cada commit.
- `cloud` depende de `spaces`, `storage`, `conversations`, `organizations`, `identity`, `platform` só pelo que exportam; ninguém importa `cloud`. Mudanças nesses módulos são mínimas e expostas pela `application/` deles.
- Nunca ler espaço que não está em `active_cloud`, nem antes do termo aceito e da cópia da chave do servidor existir. Desligar apaga **de verdade** (sem lixeira) chave do servidor, trechos, embeddings e textos extraídos daquele espaço — exceção documentada à regra de lápide (dado legível não fica).
- Dado legível (trechos, textos, prompts, respostas em claro) nunca vai a log, Sentry, auditoria nem resposta de erro; tabelas com `organization_id` + RLS por organização.
- Chave do servidor: par X25519, privada cifrada pelo KMS (envelope), aberta só em memória; cópias trancadas `0x01 ‖ crypto_box_seal` (108 chars), como as dos Hubs.
- Embeddings: `nomic-embed-text` (mesmo do Hub), modelo gravado em cada trecho. LLM: Claude via **Amazon Bedrock** (`us-east-1`, papel IAM em produção). Em testes, adaptadores falsos determinísticos por DI (o LocalStack gratuito não tem Bedrock).
- Hub primeiro, nuvem de reserva: a nuvem só assume uma mensagem `pending` depois de **30 s** sem `ack` do Hub (`CLOUD_FALLBACK_AFTER_MS = 30_000`) ou quando o assunto/mensagem pede "responder pela nuvem"; o `ack` decide quem pegou (nunca dois).
- Todo assunto de espaço em nuvem ativa nasce com a nuvem de reserva; o dono desliga por assunto.
- Orçamento de IA: mensal por organização, em micro-dólares (`bigint`), padrão **0**; avisos a 75/90/100%; estourou: `ai-budget-exceeded` (422) e nada roda; o Hub segue normal.
- Antes de cada commit: host `npm run build && npm test && npm run lint && npm run typecheck`; container `migration:run`, `schema:check`, `test:e2e` quando mexer em banco/HTTP/serviços.

## Review Focus

1. **Desligar com indexação em andamento:** um job que já tinha a chave aberta não grava trecho depois do desligar (confere o estado sob trava antes de gravar); depois do desligar, zero linhas legíveis do espaço. → Task 4.
2. **Hub volta no meio da resposta da nuvem:** o Hub recebe a mensagem já `ack`ada pela nuvem e não executa de novo; a nuvem não responde uma mensagem que o Hub confirmou. → Task 7.
3. **Orçamento estoura no meio de uma indexação grande:** para no próximo lote, registra o que gastou, retoma quando o financeiro aumenta. → Task 5.
4. **Troca de chave do espaço/assunto sem a cópia do servidor** num espaço/assunto com nuvem: 409 com o servidor entre os faltantes; nada gravado. → Tasks 3 e 6.
5. **Membro não participante de um assunto privado** pergunta à nuvem algo que só está nesse assunto: a resposta nunca usa conversas alheias (só trechos do espaço e o histórico do próprio assunto). → Task 7.

---

### Task 1: Fundações — pg-boss e chave do servidor

**Files:** `src/shared/infra/jobs/` (módulo do pg-boss: fila no próprio Postgres, schema próprio, ciclo de vida com `enableShutdownHooks`, login: decidir e documentar — runtime com GRANTs do schema do pg-boss), `src/cloud/application/ports/server-keyring.ts` + `src/cloud/infra/crypto/kms-server-keyring.ts`, `docker-compose.yaml` (LocalStack `SERVICES: s3,kms`), `.docker/localstack/init/ready.d/` (criar a chave KMS de dev), `.github/workflows/ci.yml`, `.env.example`, `env.validation.ts`, `package.json`
**Interfaces:**
- `abstract class ServerKeyring { publicKey(): Promise<string>; openSealed(copy: string): Promise<Uint8Array>; }` (pública X25519 base64url 43; `openSealed` abre uma cópia `0x01 ‖ crypto_box_seal`). A privada fica cifrada pelo KMS numa linha de banco ou arquivo de configuração (decidir; documentar rotação).
- `JobQueue` (porta) com `send(name, payload, opts)` e `work(name, handler)`; payloads só com ids.
- Rota `GET /cloud/server-key` → `{ publicKey }` (usuário autenticado).
- [ ] Testes: unit/e2e — abrir uma cópia selada com a pública do servidor volta os 32 bytes; a privada nunca sai em resposta/log; um job enfileirado roda uma vez e sobrevive a reinício; build/CI com LocalStack KMS. Commit `feat(cloud): job queue and server key`.

### Task 2: Embeddings e modelo de linguagem

**Files:** `src/cloud/application/ports/{embedder,language-model}.ts`, adaptadores `infra/embeddings/` (serviço no compose; imagem e versão fixas, documentadas; mesmo `nomic-embed-text` do Hub, com o prefixo de tarefa que o Hub usa) e `infra/bedrock/` (`@aws-sdk/client-bedrock-runtime`, modelo Claude configurável no `.env`), adaptadores falsos para testes, medição de tokens/custo na resposta
**Interfaces:** `Embedder.embed(texts: string[], kind: 'document'|'query'): Promise<{ vectors: number[][]; model: string; dimensions: number }>`; `LanguageModel.complete(input: { system: string; messages: ...; tools?: ...; maxTokens: number }): Promise<{ text; toolCalls; usage: { inputTokens; outputTokens }; model }>`; `AiPricing.costMicroUsd(usage, model)`.
- [ ] Testes: o adaptador real de embeddings no compose devolve 768 dimensões e é determinístico; o falso do LLM é usado nos e2e; custo calculado por tabela de preço no código (documentada). Commit `feat(cloud): embedding and language model ports`.

### Task 3: Termo, autorizar, ligar e desligar

**Files:** `src/cloud/domain/` (termo, aceite, ativação do espaço), tabelas (`cloud_terms` (versão, hash, texto), `cloud_term_acceptances` (org, versão, quem, quando, ip), `cloud_space_activations` (espaço, estado `authorized|active`, quem autorizou/ligou, quando), `cloud_space_key_grants` (espaço, versão da chave, cópia para o servidor)), migration(s), casos de uso e rotas; mudança mínima no `spaces`: troca de chave de espaço `active_cloud` exige a cópia do servidor (409 `key-rotation-mismatch` com o servidor entre os faltantes, extensão `missingServer: true`), `cloud_mode` muda só por este fluxo, `GET /spaces/:id` traz `cloud: { mode, activatedAt }` para todo membro
**Regras:** spec §4.1 (dois passos: quem decide aceita e autoriza com `allow_online_llm` ligado e orçamento > 0; o Gestor manda as cópias de **todas** as versões e o espaço vira `active_cloud`; órfão não liga; pessoal = mesma pessoa). Desligar (quem decide ou Gestor): apaga cópias do servidor, trechos, textos e jobs pendentes do espaço, `cloud_mode = encrypted_backup`, auditado (`space.cloud.authorized|activated|deactivated`, `organization.cloud_terms.accepted`). Termo novo exige aceite antes de autorizar espaço novo.
- [ ] Testes: e2e do ciclo completo com cripto real (`c.spaces` + selar para a pública do servidor); Gestor sem autorização → 422; admin sem ser membro não consegue mandar a chave; troca de chave sem o servidor → 409 (Review Focus 4); desligar apaga tudo. Commit `feat(cloud): terms, authorization, activation and deactivation`.

### Task 4: Manifesto, extração e índice

**Files:** `docs/hubs/space-manifest.md` (contrato: `objectId` fixo do manifesto do Hub e do manifesto da nuvem, UUID v5 do `spaceId` com rótulos sem o nome do produto; JSON cifrado versionado; arquivos com nome, tipo, origem/conector, data e partes em ordem; regras de incorporação), `src/cloud/application/indexing/` (job por espaço/objeto: lê manifestos, junta partes, decifra com a chave do espaço via `ServerKeyring`, extrai texto por formato — PDF, docx, xlsx/csv, md, txt, html —, divide em trechos, embeddings, grava), tabela `cloud_chunks` (org, espaço, objeto, versão, posição, texto, `embedding vector(768)`, modelo; índice HNSW; RLS), gancho novo em `src/shared/application/` emitido pelo `storage` na confirmação/apagar de objeto em espaço `active_cloud` (enfileira), reindexação completa ao ligar
**Regras:** spec §4.2; o job confere sob trava que o espaço ainda está ativo antes de gravar (Review Focus 1); conversas **não** entram; custo de embeddings medido (Task 5 consome).
- [ ] Testes: e2e com LocalStack, backup real cifrado e manifesto no formato do contrato (o Hub simulado em `test/support/`): ligar indexa todos os arquivos; envio novo reindexa só o objeto; apagar tira os trechos; desligar no meio não deixa linha; formato desconhecido é ignorado com registro. Commit `feat(cloud): manifest contract and backup indexing`.

### Task 5: Orçamento de IA

**Files:** `organizations` (coluna de orçamento mensal, padrão 0, `OrganizationAdministration.setAiBudget`), `src/cloud/` (livro de uso: org, espaço, tipo `answer|indexing`, custo, mês; consulta `GET /organizations/:id/ai-usage` para admins), plataforma (permissão nova `platform.billing.ai_budget` para financeiro e admin, migration do catálogo, `PUT /platform/organizations/:orgId/ai-budget` com motivo e reautenticação, auditado), avisos 75/90/100% (estado na resposta de uso e no `GET` da organização)
**Regras:** antes de cada resposta/lote de indexação, reservar o custo estimado e conferir sob trava da organização (sem estourar com concorrência); depois, acertar o real. Estourou: `ai-budget-exceeded` 422; a indexação pausa e retoma quando o orçamento sobe (Review Focus 3).
- [ ] Testes: concorrência de reservas não passa do limite; financeiro ajusta; suporte → 404; estouro para a indexação e a resposta. Commit `feat(cloud): monthly AI budget per organization`.

### Task 6: A nuvem como executor nos assuntos

**Files:** `conversations` (executor/autor "nuvem": coluna/flag `cloud_reserve` no assunto, cópias da chave do assunto para o servidor em `conversation_key_grants` (destinatário servidor, CHECK), autor `cloud` nas mensagens e no `ack` (`acked_by` servidor), troca de chave exige o servidor enquanto a reserva estiver ligada (409 com `missingServer`), dono liga/desliga a reserva (desligar: lápide na cópia + troca pendente), criação em espaço `active_cloud` exige a cópia do servidor, `requeueAckedBy` e feeds cobrindo o servidor; RLS: o servidor lê por um contexto próprio `app.cloud_executor` só nos assuntos com reserva — documentar no padrão do módulo)
**Regras:** spec §4.3 primeiro parágrafo; assuntos que já existiam ganham a reserva quando o app manda a cópia.
- [ ] Testes: e2e com cripto real — assunto novo em espaço ativo sem cópia do servidor → 422; dono desliga a reserva e a nuvem perde acesso; troca de chave sem servidor → 409 (Review Focus 4); feeds e invariantes do commit-order continuam verdes. Commit `feat(conversations): cloud reserve executor`.

### Task 7: Responder e documentar pela nuvem

**Files:** `src/cloud/application/responder/` (job agendado por mensagem `pending` em assunto com reserva, que roda depois de `CLOUD_FALLBACK_AFTER_MS` sem `ack` ou na hora se pedido "responder pela nuvem" (campo por assunto e por mensagem, no `conversations`); pega a mensagem com `ack` atômico como executor nuvem (se o Hub confirmou antes, desiste — Review Focus 2); busca trechos do espaço (pgvector) + histórico do próprio assunto (decifrado com a cópia do servidor) — nunca outras conversas (Review Focus 5); chama o `LanguageModel` com o prompt do Antares (sistema em arquivo versionado no código), mede custo (Task 5); grava a resposta cifrada com a chave do assunto como mensagem do executor nuvem), ferramenta "gravar documento" (o modelo propõe; alerta de confidencialidade com o **público do espaço** — quantas pessoas e papéis — no prompt e regra de perguntar antes; ao confirmar: objeto do backup cifrado com a chave do espaço, entrada no manifesto da nuvem, indexação imediata), rota/campo "responder pela nuvem", contrato do executor em `docs/hubs/hub-lifecycle.md` (regra de confidencialidade vale também para o Hub; o Hub incorpora o manifesto da nuvem)
- [ ] Testes: e2e com LLM falso — Hub ausente: depois de 30 s (relógio controlado) a nuvem responde e a mensagem fica `ack`ada por ela; Hub confirma antes: nuvem não responde; "responder pela nuvem": responde na hora; documento gravado aparece no manifesto da nuvem, no backup e no índice; conteúdo marcado como confidencial num espaço amplo gera pergunta, não gravação; orçamento zerado → mensagem de erro amigável no assunto (sem custo). Commit `feat(cloud): answers and documentation from the cloud`.

### Task 8: Documentação viva e contratos

**Files:** `CLAUDE.md` (seção `## Módulo cloud`, pg-boss, KMS/Bedrock/embeddings no `.env` e em produção (IAM `bedrock:InvokeModel`, `kms:Decrypt`), rate limits, Pendências: texto final do termo, documentos/artefatos nas respostas, OCR/áudio, executor com ferramentas, Hub hospedado, "Hub em software"), `docs/app/pendencias-do-app.md` (termo e ligar em dois passos, aviso permanente de nuvem ativa, cópia da chave para o servidor no espaço e nos assuntos, "responder pela nuvem", desligar reserva, uso e avisos de orçamento, confirmação de confidencialidade), `docs/hubs/` (manifesto, espelhos de conector no backup em nuvem ativa, incorporar o manifesto da nuvem, confidencialidade), DER, spec (status implementada)
- [ ] Atualizar; verificação completa; commit `docs: document active cloud`; push; CI verde. (O controlador avisa a sessão do Hub com os caminhos dos contratos.)
