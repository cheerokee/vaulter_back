# Conversas (assuntos) — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assuntos do copiloto como dado do espaço: cifrados com chave própria, pessoais, sincronizados entre app e Hub executor, com mensagens (caixa de entrada com `ack`), anexos no S3, troca de chave, mover e retenção.

**Architecture:** Módulo novo `src/conversations/` (domain/application/infra). Depende de `spaces` (`SpaceAccess`, membros), `hubs` (dono do Hub, `hub_space`, `HubDirectory`), `identity` (chaves públicas via `UserDirectory`), `storage` (porta `ObjectStore`, padrões de diário/reparo e `SpaceStorageUsage`) e `organizations` (`AuditLog`) só pelo que exportam. O `hubs` emite um gancho novo de "executor perdido" em `src/shared/application/`. Tabelas com RLS de organização **e** de participante/executor.

**Tech Stack:** NestJS 12, TypeScript 6 (ESM), TypeORM 1.x + Postgres 18 (RLS), libsodium, `@aws-sdk/client-s3` (via `ObjectStore`), LocalStack, Vitest + supertest.

**Spec:** `docs/superpowers/specs/2026-11-09-conversations-design.md` (autoridade).

## Global Constraints

- Docs pt-BR; código/logs/commits em inglês (Conventional Commits). Tudo na `develop`; push depois de cada commit.
- `conversations` só usa o que os outros módulos exportam da `application/`; ninguém importa `conversations`. Gancho novo vive em `src/shared/application/` (padrão de `SpaceMemberLeftHooks`).
- O backend nunca vê título, plano, conteúdo, nome ou tipo de anexo. Visível: ids, espaço, organização, participantes, dono, executor, `state`, horários, tamanhos, versões, `ack`.
- `state` ∈ `aviso | trabalhando | na_fila | pede_sim | esperando_pc | concluido | arquivado`.
- Executor = Hub **cujo dono participa** do assunto e com o espaço instalado (`hub_space` vivo, vínculo aprovado). Sala não é exigida.
- Cópia trancada da chave do assunto: `0x01 ‖ crypto_box_seal(chave32)`, 81 bytes, base64url 108 chars (mesmo formato das cópias do espaço). Cada participante e o executor têm cópia de **todas** as versões.
- Limites: mensagem cifrada ≤ **64 KiB**; cabeçalho cifrado ≤ **16 KiB**; anexo ≤ **100 MiB**; participantes ≤ **50**; retenção do apagado **30 dias**.
- Erros: `conversation-not-found` 404 (não participante, inexistente, outra organização: o mesmo), `conversation-key-rotation-required` 409, `conversation-key-version-stale` 409, `executor-invalid` 422, `participant-not-space-member` 422, `conversation-participant-limit` 409, `message-too-large` 422, `header-too-large` 422, `attachment-too-large` 422, `not-conversation-owner` 403 (participante sem o poder).
- Tabelas sincronizáveis com `sync_version` (`addSyncVersionTrigger`), lápide, sem `DELETE` para o runtime.
- Antes de cada commit: host `npm run build && npm test && npm run lint && npm run typecheck`; container `migration:run`, `schema:check`, `test:e2e` quando mexer em banco/HTTP/S3.

## Review Focus

1. **Membro do espaço que não participa** tenta ler assunto, mensagens, anexos ou o feed de mudanças: nada vem (404 / feed vazio), inclusive com id certo. → Task 2 (RLS) e Task 6.
2. **Mensagem reenviada com o mesmo id** depois de falha de rede: uma só no banco, mesma resposta. → Task 4.
3. **Participante sai no meio** e o app dele ainda tenta mandar mensagem com a versão antiga: 409 `conversation-key-rotation-required` (ou `-version-stale`) e nada gravado; depois da troca, só os ativos têm a versão nova. → Task 3 e 4.
4. **Hub executor desregistrado / desvinculado / espaço tirado do Hub** com mensagens `pending`: executor volta a nulo, mensagens continuam `pending`, troca de chave exigida, Hub perde o acesso. → Task 3.
5. **Dono do assunto sai do espaço** sendo o único participante: assunto vira lápide e some do feed de todos; com outros participantes, o mais antigo vira dono e, se ele não for dono do Hub executor, o executor sai. → Task 3.

---

### Task 1: Contrato cripto das conversas

**Files:** Create `docs/crypto/conversations.md`; helpers em `test/support/conversation-crypto.ts` (+ spec com vetor)
**Interfaces (teste):** `newConversationKey()`, `sealConversationKey(key, recipientPublicKey)` / `openConversationKey(copy, privateKey)` (formato das cópias do espaço); `sealHeader/openHeader`, `sealMessage/openMessage`, `sealAttachment/openAttachment` — `0x01 ‖ nonce(24) ‖ XChaCha20-Poly1305` com AD = `0x01 ‖ rótulo ("conversation-header" | "conversation-message" | "conversation-attachment") ‖ spaceId(16) ‖ conversationId(16) ‖ recordId(16) ‖ keyVersion (uint32 BE)` (cabeçalho usa `recordId = conversationId`).
- [ ] Testes que falham (vetor fixo; abrir com outro espaço/assunto/registro/versão/rótulo lança); implementar; doc com tamanhos, vetor e receita Python (PyNaCl/libsodium), como `space-backup.md`; commit `docs(crypto): conversation encryption format`.

### Task 2: Tabelas, RLS e domínio

**Files:** `src/conversations/domain/*` (assunto, participação, chave/versão, mensagem, anexo; regras puras), `src/conversations/infra/db/*` (entidades, mappers, repositórios), migration `1792896400000-CreateConversations.ts`, `conversations.module.ts`, DER
- Tabelas (todas com `organization_id`, FKs compostas para espaço/assunto, `sync_version`, lápide): `conversations` (`id` do aparelho, `space_id`, `created_by_user_id`, `owner_user_id`, `executor_hub_id` nulo, `state` CHECK, `last_message_at`, `current_key_version`, `key_rotation_required`, `encrypted_header` text, `header_key_version`, `moved_from_conversation_id` nulo); `conversation_participants` (`conversation_id`, `user_id`, `joined_at`, lápide; único vivo por par); `conversation_key_grants` (`conversation_id`, `key_version`, `user_id` **ou** `hub_id` (CHECK um dos dois), `wrapped_key` 108, lápide); `conversation_messages` (`id` do aparelho, `conversation_id`, `author_user_id` ou `author_hub_id`, `key_version`, `encrypted_body` nulo após retenção, `body_bytes`, `replaces_message_id` nulo, `pending`/`acked_at`, `sent_at`, lápide); `conversation_attachments` (`id`, `conversation_id`, `message_id` nulo, `key_version`, `size_bytes`, `sha256`, `status` pending|committed|purged, `s3_version_id`, `s3_write_started_at`, `upload_expires_at`, lápide).
- **RLS:** além de `organization_id`, SELECT/UPDATE só quando `app.user_id` é participante vivo do assunto **ou** `app.hub_id` é o executor (policy com `EXISTS` em `conversation_participants` / coluna `executor_hub_id`); INSERT de assunto exige `owner_user_id = app.user_id` ou Hub executor; sem `SECURITY DEFINER` (padrão do projeto). Testes de RLS pelo login de runtime.
- [ ] Testes que falham (unit nas regras: limites, CHECKs de estado, quem pode o quê; e2e RLS: membro não participante não vê nenhuma linha das 5 tabelas — Review Focus 1); implementar; `schema:check` vazio; commit `feat(conversations): tables, row-level security and domain`.

### Task 3: Ciclo do assunto, participantes, executor e troca de chave

**Files:** casos de uso em `src/conversations/application/` (criar — pessoa e Hub —, compartilhar, compartilhar com o espaço, sair, tirar, arquivar/reabrir/mudar estado, trocar executor, trocar chave), `src/shared/application/conversation-executor-hooks.ts` (ou nome equivalente: `HubExecutorLostHooks` com eventos `hub_deregistered`, `organization_unlinked`, `space_removed_from_hub`), emissão no `hubs` (desregistro, desvínculo/cascata, `RemoveHubSpace`, gancho de saída), assinatura em `SpaceMemberLeftHooks`; controllers (token de usuário e de Hub)
- Regras da spec §4.1–4.2 e Global Constraints: poderes (dono × participante), executor válido (dono do Hub participa + `hub_space` vivo + vínculo aprovado), executor perdido → `executor_hub_id` nulo, lápide nas cópias do Hub, `key_rotation_required`; trocar executor exige troca de chave; saída/remoção → lápide + flag; sucessão do dono (participante mais antigo); último participante sai → lápide no assunto; troca de chave por participante ativo **ou** executor com cópias de todos os ativos (+ executor), exatamente o conjunto ativo (409 com ids faltando/sobrando, como `key-rotation-mismatch`).
- Locks: seguir a ordem do `CLAUDE.md` (Hub → vínculo → hub_space → espaço → ...) e acrescentar `conversation` depois do espaço; ganchos rodam na transação de quem emite.
- [ ] Testes que falham (Review Focus 3, 4, 5; Hub de outro dono como executor → 422 `executor-invalid`; compartilhar com não membro → 422; 51º participante → 409); implementar; commit `feat(conversations): lifecycle, participants, executor and key rotation`.

### Task 4: Mensagens e caixa de entrada

**Files:** casos de uso de mandar (pessoa e Hub), confirmar (`ack`, só executor), apagar a própria, editar como nova; atualização de `last_message_at`; uso do espaço (`body_bytes` entra no `SpaceStorageUsage` junto com anexos — estender a fonte registrada sem quebrar a do storage); rate limits por usuário e por Hub
- Mandar: id do aparelho idempotente (mesmo id + mesmo autor = mesma resposta; mesmo id com conteúdo diferente = 409 `message-id-conflict`), `keyVersion` = atual, flag de troca → 409; mensagem de pessoa nasce `pending`, do executor nasce confirmada; espaço cheio → 422 `space-storage-full` (mesma regra do storage).
- [ ] Testes que falham (Review Focus 2 e 3; ack por quem não é executor → 404; apagar mensagem alheia → 403); implementar; commit `feat(conversations): messages and inbox acknowledgements`.

### Task 5: Anexos

**Files:** intenção/confirmação/baixar de anexos do assunto reaproveitando `ObjectStore`, o diário (`s3_write_started_at` no relógio do banco, reconfirmado sob trava) e o reparo do storage (extrair o que for genérico para uma peça compartilhada dentro do `storage` exportada pela `application/`, sem duplicar); caminho `orgs/<orgId>/spaces/<spaceId>/conversations/<conversationId>/<attachmentId>`; ≤ 100 MiB; contam no uso do espaço; reconcile cobre também esta tabela
- [ ] Testes que falham (ciclo com LocalStack e cifra real; não participante → 404; tamanho/sha256 divergente → `upload-mismatch`); implementar; commit `feat(conversations): encrypted attachments`.

### Task 6: Sincronização (app e Hub executor)

**Files:** `GET /conversations/changes?since=&limit=` (pessoa: assuntos em que participa + mensagens, participações, cópias da chave dela, anexos; lápides incluídas) e `GET /hub/conversations/changes?since=&limit=&wait=` (executor; sondagem longa até 25 s, acordando por `LISTEN/NOTIFY` do Postgres ou por releitura curta — escolha do builder, documentada); mesmo cuidado de grupo/página da sincronização do Hub (`mergeSyncPage`)
- [ ] Testes que falham (pessoa vê só o que participa — Review Focus 1; Hub vê só onde é executor; lápides chegam; a sondagem acorda com uma mensagem nova em < 2 s no e2e); implementar; commit `feat(conversations): sync feeds and long polling`.

### Task 7: Mover, retenção e lixeira do assunto

**Files:** criar com `movedFrom` (só o dono, membro dos dois espaços; participantes não membros do destino ficam de fora) + lápide no antigo; rotina de retenção que zera `encrypted_body` e marca anexos apagados há > 30 dias (no `npm run storage:reconcile` ou script próprio `conversations:retention`, documentado); "esvaziar a lixeira do assunto" pelo dono (reautenticação, como a do espaço)
- [ ] Testes que falham (mover com e sem membros comuns; retenção zera só o que passou de 30 dias; Gestor não alcança assunto alheio); implementar; commit `feat(conversations): move, retention and conversation trash`.

### Task 8: Documentação viva

**Files:** `CLAUDE.md` (seção `## Módulo conversations`; ordem de locks; ganchos; rate limits; pendências: notificações, nuvem ativa, executor na nuvem, integradores, WebSocket), `docs/hubs/hub-lifecycle.md` (o Hub como executor: feed, sondagem longa, ack, troca de chave), `docs/app/pendencias-do-app.md` (assuntos no app: cifra no celular, compartilhar, mover, lixeira, aviso de troca de chave do assunto), DER, spec (status implementada)
- [ ] Atualizar; verificação completa; commit `docs: document conversations module`; push; CI verde. (O controlador avisa a sessão do Hub com os caminhos.)
