-- Vaulter — modelo de contas, organizações, espaços e hubs.
-- Fonte: valter-valt-ai/docs/superpowers/specs/2026-10-24-organizacoes-espacos-e-nuvem-design.md
--
-- Dialeto MySQL só para o MySQL Workbench desenhar o DER
-- (File > Import > Reverse Engineer MySQL Create Script, marcando "Place imported objects on a diagram").
-- O banco real é PostgreSQL e nasce das migrations do TypeORM, com estes tipos:
--   CHAR(36)  -> uuid
--   DATETIME  -> timestamptz
--   TINYINT   -> boolean
--   ENUM(...) -> enum do Postgres (ou varchar + check)
--   JSON      -> jsonb
-- Índices únicos com deleted_at viram índices únicos parciais (WHERE deleted_at IS NULL) no Postgres.
-- FKs de filho de espaço (space_keys, space_key_grants, space_pending_grants, invitation_space_intents e
-- role_assignments.space_id) são compostas com organization_id — (filho_id, organization_id) ->
-- (pai.id, pai.organization_id), com UNIQUE INDEX uq_*_id_organization (id, organization_id) em spaces,
-- space_keys e organization_invitations —, porque a checagem de FK ignora o RLS. Estão modeladas assim
-- (duas colunas) neste script e no .mwb. MATCH SIMPLE: linha com coluna nula (role_assignments fora do
-- escopo espaço, pendência sem convite) não é checada.
--
-- Offline-first: tabelas que o hub/app sincronizam NUNCA têm DELETE físico; excluir = preencher deleted_at
-- (lápide). Tabela de ligação com PK composta que volta a existir = limpar deleted_at, não inserir de novo.
-- sync_version: no Postgres, uma sequência global única (sync_version_seq) atribuída por trigger em todo
-- insert/update (inclusive ao gravar a lápide). O cliente guarda o maior valor visto e pede "tudo com
-- sync_version maior", lápides incluídas. Não usar updated_at para isso (relógio diverge).
-- Limpeza: lápides com mais de 90 dias são apagadas de vez por rotina; cliente parado há mais de 30 dias
-- (limite do login offline) faz sincronização completa. LGPD: pedido de esquecimento apaga/anonimiza os
-- campos pessoais e deixa só id + deleted_at.
--
-- Convenção: tabelas de entidade no plural; tabelas de ligação com os dois nomes no singular.
-- Toda tabela tem created_at, updated_at e deleted_at (uma entidade base no TypeORM: @CreateDateColumn,
-- @UpdateDateColumn, @DeleteDateColumn); sync_version só nas que o hub/app sincronizam.

CREATE SCHEMA IF NOT EXISTS vaulter;
USE vaulter;

-- ---------------------------------------------------------------------------------------------------
-- Usuários e papéis da plataforma
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE users (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  -- A senha nunca chega ao servidor: o cliente deriva dela uma prova de login (auth_hash, guardada aqui já
  -- com hash do servidor) e uma chave que abre encrypted_private_key. Sem a senha, a conta e os dados voltam
  -- só pelo código de recuperação (recovery_*, abaixo): ele abre a mesma chave privada e o app grava a senha nova.
  auth_hash VARCHAR(255) NOT NULL,
  kdf_salt VARCHAR(64) NOT NULL,
  kdf_params JSON NOT NULL,
  -- Par de chaves do usuário: com a pública, quem já está num espaço tranca a chave do espaço para ele.
  public_key TEXT NOT NULL,
  encrypted_private_key TEXT NOT NULL,
  -- Recuperação da conta pelo código de recuperação (formato em docs/crypto/user-keys.md): recovery_hash guarda só o
  -- hash com chave da prova derivada do código; recovery_encrypted_private_key é a mesma chave privada selada com o
  -- código, cópia feita no aparelho (por isso não há preenchimento retroativo).
  recovery_hash VARCHAR(64) NOT NULL,
  recovery_encrypted_private_key TEXT NOT NULL,
  sync_version BIGINT NOT NULL COMMENT 'versão de sincronização: sequência global do servidor, muda a cada insert/update/exclusão',
  PRIMARY KEY (id),
  UNIQUE INDEX uq_users_email (email),
  INDEX ix_users_sync_version (sync_version)
);

-- Sessão por aparelho (app, Hub). Não sincronizável: fica só no backend. Revogar = revoked_at; nada é apagado.
CREATE TABLE user_sessions (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  user_id CHAR(36) NOT NULL,
  device_name VARCHAR(100) NOT NULL,
  device_platform ENUM('android', 'ios', 'hub', 'web', 'other') NOT NULL DEFAULT 'other',
  hub_id CHAR(36) NULL COMMENT 'Hub que abriu a sessão (POST /hub/user-sessions); CHECK: device_platform = hub <=> hub_id preenchido; cai (hub_access_lost) quando a pessoa perde o papel no Hub',
  refresh_token_hash VARCHAR(128) NOT NULL COMMENT 'hash do refresh atual; refresh rotativo, reuso revoga a sessão',
  refresh_expires_at DATETIME NOT NULL COMMENT '30 dias de inatividade, renovado a cada refresh',
  last_used_at DATETIME NOT NULL,
  last_ip VARCHAR(45) NULL,
  user_agent VARCHAR(500) NULL,
  revoked_at DATETIME NULL,
  revoked_reason ENUM('logout', 'revoked', 'refresh_reuse', 'password_change', 'account_recovery', 'hub_access_lost') NULL,
  PRIMARY KEY (id),
  INDEX ix_user_sessions_user (user_id, revoked_at),
  INDEX ix_user_sessions_hub (hub_id, user_id) COMMENT 'só sessões vivas presas a um Hub (WHERE hub_id IS NOT NULL AND revoked_at IS NULL no Postgres)',
  CONSTRAINT fk_user_sessions_users FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_user_sessions_hubs FOREIGN KEY (hub_id) REFERENCES hubs (id)
);

-- Papéis da plataforma (equipe: suporte, financeiro...). Separados dos papéis de cliente (roles), que têm escopo
-- de organização/espaço/hub e chegam ao hub; estes ficam só no backend: sem sync_version, sem RLS e fora da
-- sincronização. Catálogo fixo (platform_roles, platform_permissions, platform_role_permission) semeado por migration
-- imutável; o runtime só lê. Spec: docs/superpowers/specs/2026-11-07-platform-roles-design.md.
CREATE TABLE platform_roles (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  `key` VARCHAR(50) NOT NULL COMMENT 'código fixo usado pelo backend (ex.: platform_support); name é só exibição',
  name VARCHAR(255) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE INDEX uq_platform_roles_key (`key`) COMMENT 'único entre vivos (WHERE deleted_at IS NULL no Postgres)'
);

CREATE TABLE platform_permissions (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  `key` VARCHAR(100) NOT NULL COMMENT 'ex.: platform.support.request',
  PRIMARY KEY (id),
  UNIQUE INDEX uq_platform_permissions_key (`key`)
);

CREATE TABLE platform_role_permission (
  platform_role_id CHAR(36) NOT NULL,
  platform_permission_id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  PRIMARY KEY (platform_role_id, platform_permission_id),
  INDEX fk_platform_role_permission_platform_permissions_idx (platform_permission_id),
  CONSTRAINT fk_platform_role_permission_platform_roles FOREIGN KEY (platform_role_id) REFERENCES platform_roles (id),
  CONSTRAINT fk_platform_role_permission_platform_permissions FOREIGN KEY (platform_permission_id) REFERENCES platform_permissions (id)
);

-- Retirar o papel = lápide (deleted_at); dar de novo limpa o deleted_at da mesma linha. Runtime sem DELETE.
CREATE TABLE user_platform_role (
  user_id CHAR(36) NOT NULL,
  platform_role_id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  PRIMARY KEY (user_id, platform_role_id),
  INDEX fk_user_platform_role_platform_roles_idx (platform_role_id),
  CONSTRAINT fk_user_platform_role_users FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_user_platform_role_platform_roles FOREIGN KEY (platform_role_id) REFERENCES platform_roles (id)
);

-- ---------------------------------------------------------------------------------------------------
-- Organizações e membros
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE organizations (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  name VARCHAR(255) NOT NULL,
  is_personal TINYINT NOT NULL DEFAULT 0 COMMENT 'organização de uma pessoa só',
  hub_link_policy ENUM('any_member_hub', 'admin_approved') NOT NULL DEFAULT 'any_member_hub',
  allow_room_spaces TINYINT NOT NULL DEFAULT 1 COMMENT 'política da organização: permite liberar espaços na Sala dos Hubs; admin muda no PATCH da organização',
  plan VARCHAR(50) NOT NULL DEFAULT 'free' COMMENT 'decide se a nuvem ativa está liberada',
  -- Kit de recuperação: a parte privada é mostrada uma vez ao cliente; aqui só a pública, para trancar as
  -- chaves dos espaços (space_keys.recovery_wrapped_key). Nulo até o primeiro espaço ou ação explícita.
  recovery_public_key TEXT NULL,
  recovery_key_changed_at DATETIME NULL COMMENT 'última troca do kit (registro ou substituição); anda junto com recovery_key_changed_by_user_id',
  recovery_key_changed_by_user_id CHAR(36) NULL COMMENT 'quem trocou o kit por último; o app mostra antes de retrancar',
  -- Proteção depois de um admin nomeado pela plataforma (spec platform-roles §4.4): os três andam juntos; enquanto
  -- now < protected_until ninguém troca o kit nem remove membro. Uma nomeação nova sobrescreve os três.
  platform_appointed_user_id CHAR(36) NULL COMMENT 'último admin nomeado pela plataforma',
  platform_appointed_at DATETIME NULL COMMENT 'quando foi a última nomeação pela plataforma',
  protected_until DATETIME NULL COMMENT 'fim da janela de proteção (nomeação + 7 dias)',
  personal_owner_user_id CHAR(36) NULL COMMENT 'dono da organização pessoal; nulo nas demais; garante uma pessoal por conta',
  storage_quota_bytes BIGINT NOT NULL DEFAULT 53687091200 COMMENT 'franquia de nuvem (50 GiB): a soma dos storage_quota_bytes dos espaços vivos não passa dela; CHECK > 0',
  sync_version BIGINT NOT NULL COMMENT 'versão de sincronização: sequência global do servidor, muda a cada insert/update/exclusão',
  PRIMARY KEY (id),
  UNIQUE INDEX uq_organizations_personal_owner (personal_owner_user_id),
  INDEX ix_organizations_sync_version (sync_version),
  CONSTRAINT fk_organizations_personal_owner FOREIGN KEY (personal_owner_user_id) REFERENCES users (id),
  CONSTRAINT fk_organizations_recovery_key_changed_by FOREIGN KEY (recovery_key_changed_by_user_id) REFERENCES users (id),
  CONSTRAINT fk_organizations_platform_appointed_user FOREIGN KEY (platform_appointed_user_id) REFERENCES users (id)
);

-- Ser membro da organização. O que o membro pode fazer vem de role_assignments (escopo organização).
CREATE TABLE user_organization (
  organization_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL COMMENT 'saiu da organização; os dados ficam nos espaços',
  sync_version BIGINT NOT NULL COMMENT 'versão de sincronização: sequência global do servidor, muda a cada insert/update/exclusão',
  PRIMARY KEY (organization_id, user_id),
  INDEX fk_user_organization_users_idx (user_id),
  CONSTRAINT fk_user_organization_organizations FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_user_organization_users FOREIGN KEY (user_id) REFERENCES users (id),
  INDEX ix_user_organization_sync_version (sync_version)
);

-- Convites para entrar na organização. Só do backend (não sincroniza com hub/app). Uso único, validade de
-- 7 dias; o token só existe como hash (o valor em claro vai apenas no link enviado).
CREATE TABLE organization_invitations (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  organization_id CHAR(36) NOT NULL,
  token_hash VARCHAR(128) NOT NULL COMMENT 'hash do token do convite; o token em claro nunca é guardado',
  email VARCHAR(255) NULL COMMENT 'e-mail convidado; nulo = convite por link aberto',
  role_id CHAR(36) NOT NULL COMMENT 'papel concedido ao aceitar',
  status ENUM('pending', 'accepted', 'revoked', 'expired') NOT NULL DEFAULT 'pending',
  expires_at DATETIME NOT NULL,
  created_by_user_id CHAR(36) NOT NULL,
  accepted_by_user_id CHAR(36) NULL,
  accepted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE INDEX uq_organization_invitations_token_hash (token_hash),
  UNIQUE INDEX uq_organization_invitations_id_organization (id, organization_id) COMMENT 'alvo das FKs compostas (filho_id, organization_id)',
  INDEX fk_organization_invitations_organizations_idx (organization_id),
  INDEX fk_organization_invitations_roles_idx (role_id),
  INDEX fk_organization_invitations_created_by_idx (created_by_user_id),
  INDEX fk_organization_invitations_accepted_by_idx (accepted_by_user_id),
  CONSTRAINT fk_organization_invitations_organizations FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_organization_invitations_roles FOREIGN KEY (role_id) REFERENCES roles (id),
  CONSTRAINT fk_organization_invitations_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id),
  CONSTRAINT fk_organization_invitations_accepted_by FOREIGN KEY (accepted_by_user_id) REFERENCES users (id)
);

-- ---------------------------------------------------------------------------------------------------
-- Hubs
-- ---------------------------------------------------------------------------------------------------

-- Identidade do Hub: par Ed25519 (assina: apresentação, status e autenticação) + par X25519 (recebe as chaves
-- dos espaços liberados na Sala). Formatos e rótulos em docs/crypto/hub-identity.md.
-- hubs é sincronizável e NÃO tem organization_id (o Hub não pertence a nenhuma organização).
-- RLS (Postgres): SELECT se owner_user_id = app.user_id, OU id = app.hub_id (Hub autenticado), OU o Hub tem vínculo
-- aprovado com organização de que app.user_id é membro ativo, OU signing_public_key = app.hub_signing_public_key
-- (busca da apresentação); INSERT pelo dono (contexto de reivindicação: app.user_id = owner_user_id gravado);
-- UPDATE pelo dono ou pelo próprio Hub (last_seen_at, storage_capacity_bytes). Matriz completa na migration CreateHubs.
CREATE TABLE hubs (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  owner_user_id CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  encryption_public_key TEXT NOT NULL COMMENT 'X25519 (antes public_key): para trancar as chaves dos espaços abertos na sala',
  signing_public_key VARCHAR(64) NOT NULL COMMENT 'Ed25519 (base64url): única para sempre, inclusive de Hubs desregistrados (sem WHERE deleted_at no Postgres)',
  last_seen_at DATETIME NULL,
  storage_capacity_bytes BIGINT NULL COMMENT 'capacidade utilizável do SSD informada pelo Hub (PUT /hub/storage); nula = sem conferência ao instalar; CHECK > 0',
  sync_version BIGINT NOT NULL COMMENT 'versão de sincronização: sequência global do servidor, muda a cada insert/update/exclusão',
  PRIMARY KEY (id),
  UNIQUE INDEX uq_hubs_signing_public_key (signing_public_key),
  UNIQUE INDEX uq_hubs_id_owner (id, owner_user_id) COMMENT 'alvo da FK composta de hub_organization (hub_id, hub_owner_user_id)',
  INDEX fk_hubs_users_idx (owner_user_id),
  CONSTRAINT fk_hubs_users FOREIGN KEY (owner_user_id) REFERENCES users (id),
  INDEX ix_hubs_sync_version (sync_version)
);

-- Apresentação de um Hub que ainda não tem dono (assinada com a chave do Hub, rótulo hub-enroll-v1).
-- Só do backend (não sincroniza com hub/app). Fora do RLS de organização: ainda não pertence a ninguém; só o
-- caso de uso de reivindicação a acessa, pelo hash do código. Não é dado de cliente.
-- Postgres: UNIQUE (signing_public_key, nonce) (nonce de uso único) e índices únicos parciais em claim_code_hash
-- e em signing_public_key WHERE status = 'pending' (uma pendente por chave: a apresentação nova expira a anterior).
-- Limpeza das expiradas por rotina.
CREATE TABLE hub_enrollments (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  signing_public_key VARCHAR(64) NOT NULL,
  encryption_public_key TEXT NOT NULL,
  nonce VARCHAR(32) NOT NULL COMMENT '16 bytes em base64url; uso único por signing_public_key',
  claim_code_hash VARCHAR(64) NOT NULL COMMENT 'hex de crypto_generichash(32, código de 8 dígitos) com chave do servidor; nunca o código',
  expires_at DATETIME NOT NULL COMMENT 'vale 10 minutos',
  status ENUM('pending', 'claimed', 'expired') NOT NULL DEFAULT 'pending',
  claimed_hub_id CHAR(36) NULL,
  PRIMARY KEY (id),
  UNIQUE INDEX uq_hub_enrollments_key_nonce (signing_public_key, nonce),
  UNIQUE INDEX uq_hub_enrollments_claim_code_hash (claim_code_hash) COMMENT 'Postgres: parcial WHERE status = pending',
  UNIQUE INDEX uq_hub_enrollments_pending_signing_key (signing_public_key) COMMENT 'Postgres: parcial WHERE status = pending (uma pendente por chave)',
  INDEX fk_hub_enrollments_hubs_idx (claimed_hub_id),
  CONSTRAINT fk_hub_enrollments_hubs FOREIGN KEY (claimed_hub_id) REFERENCES hubs (id)
);

-- Código de vínculo pedido pelo Hub: outro membro (não o dono), diante do aparelho, o usa para pedir o vínculo de
-- uma organização sua sem conhecer o hub_id (o dono vincula direto). Uso único, vale 10 min, só hash.
-- Só do backend (não sincroniza). Fora do RLS de organização. Postgres: índice único parcial em code_hash
-- WHERE used_at IS NULL AND deleted_at IS NULL (vigentes; o vencido não usado ganha lápide e libera o hash). As três tabelas só do backend não têm DELETE para o runtime: apresentação
-- vencida vira status = expired; código vencido não usado ganha lápide (libera o hash); desafios usados/vencidos
-- ficam; a remoção física é pendência.
CREATE TABLE hub_link_codes (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  hub_id CHAR(36) NOT NULL,
  code_hash VARCHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE INDEX uq_hub_link_codes_code_hash (code_hash) COMMENT 'Postgres: parcial WHERE used_at IS NULL AND deleted_at IS NULL (expireStale grava lápide nos vencidos e libera o hash)',
  INDEX fk_hub_link_codes_hubs_idx (hub_id),
  CONSTRAINT fk_hub_link_codes_hubs FOREIGN KEY (hub_id) REFERENCES hubs (id)
);

-- Desafio de autenticação do Hub (válido por 60 s, uso único; assinatura com rótulo hub-auth-v1). hub_id nulo =
-- desafio falso para Hub inexistente (sem oráculo; nunca valida). Só hash. Só do backend (não sincroniza).
-- Fora do RLS de organização.
CREATE TABLE hub_auth_challenges (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  hub_id CHAR(36) NULL,
  challenge_hash VARCHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE INDEX uq_hub_auth_challenges_hash (challenge_hash),
  INDEX fk_hub_auth_challenges_hubs_idx (hub_id),
  CONSTRAINT fk_hub_auth_challenges_hubs FOREIGN KEY (hub_id) REFERENCES hubs (id)
);

-- ---------------------------------------------------------------------------------------------------
-- Integrações: apps e instalações (API de integração)
-- Spec: valter-valt-ai/docs/superpowers/specs/2026-10-24-api-de-integracao-design.md
-- App = sistema integrador (ex.: Salte), registrado uma vez por uma organização publicadora.
-- Instalação = app x organização cliente (ex.: Salte na Britago). Quem recebe papéis é a instalação.
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE apps (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  publisher_organization_id CHAR(36) NOT NULL COMMENT 'organização dona do app no Vaulter (ex.: a do Salte)',
  name VARCHAR(255) NOT NULL,
  description VARCHAR(500) NULL,
  public_key TEXT NOT NULL COMMENT 'o app assina o pedido de token (OAuth client credentials com private_key_jwt)',
  status ENUM('active', 'suspended') NOT NULL DEFAULT 'active',
  sync_version BIGINT NOT NULL COMMENT 'versão de sincronização: sequência global do servidor, muda a cada insert/update/exclusão',
  PRIMARY KEY (id),
  INDEX fk_apps_organizations_idx (publisher_organization_id),
  CONSTRAINT fk_apps_organizations FOREIGN KEY (publisher_organization_id) REFERENCES organizations (id),
  INDEX ix_apps_sync_version (sync_version)
);

CREATE TABLE app_installations (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  app_id CHAR(36) NOT NULL,
  organization_id CHAR(36) NOT NULL COMMENT 'organização cliente que instalou (plano precisa liberar integrações)',
  status ENUM('active', 'suspended', 'revoked') NOT NULL DEFAULT 'active' COMMENT 'revogar invalida os tokens na hora',
  installed_by_user_id CHAR(36) NOT NULL COMMENT 'administrador daquela organização',
  -- Um par de chaves por instalação (nunca um por app): vazar a da Britago não afeta a Britec.
  signing_public_key TEXT NOT NULL COMMENT 'o integrador assina cada comando; o hub confere com esta chave',
  encryption_public_key TEXT NOT NULL COMMENT 'para trancar a chave de um espaço para a instalação (space_key_grants)',
  sync_version BIGINT NOT NULL COMMENT 'versão de sincronização: sequência global do servidor, muda a cada insert/update/exclusão',
  PRIMARY KEY (id),
  UNIQUE INDEX uq_app_installations_app_organization (app_id, organization_id),
  INDEX fk_app_installations_organizations_idx (organization_id),
  INDEX fk_app_installations_installed_by_idx (installed_by_user_id),
  CONSTRAINT fk_app_installations_apps FOREIGN KEY (app_id) REFERENCES apps (id),
  CONSTRAINT fk_app_installations_organizations FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_app_installations_installed_by FOREIGN KEY (installed_by_user_id) REFERENCES users (id),
  INDEX ix_app_installations_sync_version (sync_version)
);

-- ---------------------------------------------------------------------------------------------------
-- Espaços e chaves
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE spaces (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  organization_id CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  cloud_mode ENUM('encrypted_backup', 'active_cloud') NOT NULL DEFAULT 'encrypted_backup',
  allow_online_llm TINYINT NOT NULL DEFAULT 1 COMMENT 'v1: só o campo; todos permitidos',
  current_key_version INT NOT NULL DEFAULT 1,
  key_rotation_required TINYINT NOT NULL DEFAULT 0 COMMENT 'flag de coordenação do backend: troca de chave pendente após a saída de um membro',
  storage_quota_bytes BIGINT NOT NULL DEFAULT 10737418240 COMMENT 'tamanho reservado (10 GiB; 1 GiB..5 TiB): soma na franquia da organização e na capacidade de cada Hub onde está; CHECK > 0',
  sync_version BIGINT NOT NULL COMMENT 'versão de sincronização: sequência global do servidor, muda a cada insert/update/exclusão',
  PRIMARY KEY (id),
  UNIQUE INDEX uq_spaces_id_organization (id, organization_id) COMMENT 'alvo das FKs compostas (filho_id, organization_id)',
  INDEX fk_spaces_organizations_idx (organization_id),
  CONSTRAINT fk_spaces_organizations FOREIGN KEY (organization_id) REFERENCES organizations (id),
  INDEX ix_spaces_sync_version (sync_version)
);

-- Uma linha por versão da chave do espaço (troca quando alguém sai). A chave em si nunca fica aberta aqui.
CREATE TABLE space_keys (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  organization_id CHAR(36) NOT NULL COMMENT 'desnormalizado para o RLS',
  space_id CHAR(36) NOT NULL,
  version INT NOT NULL,
  recovery_wrapped_key TEXT NOT NULL COMMENT 'trancada com organizations.recovery_public_key (kit)',
  recovery_key_fingerprint VARCHAR(64) NOT NULL COMMENT 'hash do kit usado',
  sync_version BIGINT NOT NULL COMMENT 'versão de sincronização: sequência global do servidor, muda a cada insert/update/exclusão',
  PRIMARY KEY (id),
  UNIQUE INDEX uq_space_keys_space_version (space_id, version),
  UNIQUE INDEX uq_space_keys_id_organization (id, organization_id) COMMENT 'alvo das FKs compostas (filho_id, organization_id)',
  INDEX fk_space_keys_spaces_idx (space_id, organization_id),
  INDEX fk_space_keys_organizations_idx (organization_id),
  CONSTRAINT fk_space_keys_organizations FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_space_keys_spaces FOREIGN KEY (space_id, organization_id) REFERENCES spaces (id, organization_id),
  INDEX ix_space_keys_sync_version (sync_version)
);

-- Cópias trancadas da chave do espaço: uma por pessoa, por hub autorizado ou por instalação de app.
CREATE TABLE space_key_grants (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  organization_id CHAR(36) NOT NULL COMMENT 'desnormalizado para o RLS',
  space_key_id CHAR(36) NOT NULL,
  user_id CHAR(36) NULL,
  hub_id CHAR(36) NULL,
  app_installation_id CHAR(36) NULL,
  wrapped_key TEXT NOT NULL COMMENT 'trancada com a public_key do usuário, do hub ou da instalação (exatamente um dos três)',
  sync_version BIGINT NOT NULL COMMENT 'versão de sincronização: sequência global do servidor, muda a cada insert/update/exclusão',
  PRIMARY KEY (id),
  UNIQUE INDEX uq_space_key_grants_user (space_key_id, user_id),
  UNIQUE INDEX uq_space_key_grants_hub (space_key_id, hub_id),
  UNIQUE INDEX uq_space_key_grants_installation (space_key_id, app_installation_id),
  INDEX fk_space_key_grants_space_keys_idx (space_key_id, organization_id),
  INDEX fk_space_key_grants_organizations_idx (organization_id),
  INDEX fk_space_key_grants_users_idx (user_id),
  INDEX fk_space_key_grants_hubs_idx (hub_id),
  INDEX fk_space_key_grants_app_installations_idx (app_installation_id),
  CONSTRAINT fk_space_key_grants_organizations FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_space_key_grants_space_keys FOREIGN KEY (space_key_id, organization_id) REFERENCES space_keys (id, organization_id),
  CONSTRAINT fk_space_key_grants_users FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_space_key_grants_hubs FOREIGN KEY (hub_id) REFERENCES hubs (id),
  CONSTRAINT fk_space_key_grants_app_installations FOREIGN KEY (app_installation_id) REFERENCES app_installations (id),
  INDEX ix_space_key_grants_sync_version (sync_version)
);

-- Vínculo com dois consentimentos: o dono do hub pede; a política da organização decide se precisa de admin.
-- Os dois consentimentos têm colunas próprias (owner_approved_*, org_approved_*), no lugar do antigo
-- approved_by_user_id/approved_at; status (pending | approved | rejected | revoked) é derivado dos dois.
-- RLS: a policy da organização (única via de escrita), mais leitura pelo membro ativo da organização (só vínculo
-- approved sem lápide), pelo dono do Hub (hub_owner_user_id = app.user_id) e pelo próprio Hub (hub_id = app.hub_id,
-- qualquer status: a sincronização manda o que não é approved como lápide). CHECK no Postgres:
-- owner_approved_by_user_id nulo ou igual a hub_owner_user_id. hub_owner_user_id é o dono
-- desnormalizado: a policy de hubs consulta esta tabela, então a desta não pode consultar hubs (recursão); a FK
-- composta (hub_id, hub_owner_user_id) -> hubs (id, owner_user_id) garante que é o dono real.
CREATE TABLE hub_organization (
  hub_id CHAR(36) NOT NULL,
  organization_id CHAR(36) NOT NULL,
  hub_owner_user_id CHAR(36) NOT NULL COMMENT 'dono do Hub, desnormalizado para o RLS (FK composta com hub_id)',
  status ENUM('pending', 'approved', 'rejected', 'revoked') NOT NULL DEFAULT 'pending',
  requested_by_user_id CHAR(36) NOT NULL,
  owner_approved_by_user_id CHAR(36) NULL,
  owner_approved_at DATETIME NULL,
  org_approved_by_user_id CHAR(36) NULL,
  org_approved_at DATETIME NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  sync_version BIGINT NOT NULL COMMENT 'versão de sincronização: sequência global do servidor, muda a cada insert/update/exclusão',
  PRIMARY KEY (hub_id, organization_id),
  INDEX fk_hub_organization_organizations_idx (organization_id),
  INDEX fk_hub_organization_hubs_idx (hub_id, hub_owner_user_id),
  INDEX fk_hub_organization_hub_owner_idx (hub_owner_user_id),
  INDEX fk_hub_organization_requested_by_idx (requested_by_user_id),
  INDEX fk_hub_organization_owner_approved_by_idx (owner_approved_by_user_id),
  INDEX fk_hub_organization_org_approved_by_idx (org_approved_by_user_id),
  CONSTRAINT fk_hub_organization_hubs FOREIGN KEY (hub_id, hub_owner_user_id) REFERENCES hubs (id, owner_user_id),
  CONSTRAINT fk_hub_organization_organizations FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_hub_organization_requested_by FOREIGN KEY (requested_by_user_id) REFERENCES users (id),
  CONSTRAINT fk_hub_organization_owner_approved_by FOREIGN KEY (owner_approved_by_user_id) REFERENCES users (id),
  CONSTRAINT fk_hub_organization_org_approved_by FOREIGN KEY (org_approved_by_user_id) REFERENCES users (id),
  INDEX ix_hub_organization_sync_version (sync_version)
);

-- Quais espaços estão num hub. Quem usa o quê nele (inclusive a "sala", sem login) vem de role_assignments.
-- organization_id desnormalizado, com FK composta (space_id, organization_id) -> spaces (id, organization_id)
-- (a checagem de FK ignora o RLS) e FK composta (hub_id, organization_id) -> hub_organization (só entra espaço de
-- organização vinculada); RLS por organização (única via de escrita), mais leitura pelo dono do Hub e pelo próprio
-- Hub (hub_id = app.hub_id, só com vínculo approved sem lápide da organização da linha).
CREATE TABLE hub_space (
  hub_id CHAR(36) NOT NULL,
  space_id CHAR(36) NOT NULL,
  organization_id CHAR(36) NOT NULL,
  added_by_user_id CHAR(36) NOT NULL COMMENT 'quem pôs (ou pôs de novo) o espaço no Hub',
  created_at DATETIME NOT NULL,
  deleted_at DATETIME NULL,
  updated_at DATETIME NULL,
  sync_version BIGINT NOT NULL COMMENT 'versão de sincronização: sequência global do servidor, muda a cada insert/update/exclusão',
  PRIMARY KEY (hub_id, space_id),
  INDEX fk_hub_space_spaces_idx (space_id, organization_id),
  INDEX fk_hub_space_organizations_idx (organization_id),
  INDEX fk_hub_space_added_by_idx (added_by_user_id),
  INDEX fk_hub_space_hub_organization_idx (hub_id, organization_id),
  CONSTRAINT fk_hub_space_hubs FOREIGN KEY (hub_id) REFERENCES hubs (id),
  CONSTRAINT fk_hub_space_spaces FOREIGN KEY (space_id, organization_id) REFERENCES spaces (id, organization_id),
  CONSTRAINT fk_hub_space_organizations FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_hub_space_added_by FOREIGN KEY (added_by_user_id) REFERENCES users (id),
  CONSTRAINT fk_hub_space_hub_organization FOREIGN KEY (hub_id, organization_id) REFERENCES hub_organization (hub_id, organization_id),
  INDEX ix_hub_space_sync_version (sync_version)
);

-- ---------------------------------------------------------------------------------------------------
-- Permissões: RBAC com escopo (organização, espaço, hub)
-- Catálogo de permissões fixo (só o Vaulter cria, cada uma é uma checagem no código). Papéis de fábrica
-- (organization_id nulo, imutáveis) para o modo simples; papéis próprios da organização (cópias editáveis)
-- para o modo avançado. O hub guarda uma cópia para checar offline.
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE permissions (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL COMMENT 'permissão nova não entra sozinha em papel próprio: o app compara com roles.permissions_reviewed_at',
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  `key` VARCHAR(100) NOT NULL COMMENT 'ex.: memory.read, memory.write, chat.live, camera.view, nodes.control, mesh.dispatch',
  scope_type ENUM('organization', 'space', 'hub') NOT NULL,
  name VARCHAR(255) NOT NULL,
  description VARCHAR(500) NULL,
  sync_version BIGINT NOT NULL COMMENT 'versão de sincronização: sequência global do servidor, muda a cada insert/update/exclusão',
  PRIMARY KEY (id),
  UNIQUE INDEX uq_permissions_key (`key`),
  INDEX ix_permissions_sync_version (sync_version)
);

-- Uma permissão que exige outra (ex.: camera.live exige camera.view). O editor de papéis marca sozinho.
CREATE TABLE permission_dependency (
  permission_id CHAR(36) NOT NULL,
  requires_permission_id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  sync_version BIGINT NOT NULL COMMENT 'versão de sincronização: sequência global do servidor, muda a cada insert/update/exclusão',
  PRIMARY KEY (permission_id, requires_permission_id),
  INDEX fk_permission_dependency_requires_idx (requires_permission_id),
  CONSTRAINT fk_permission_dependency_permissions FOREIGN KEY (permission_id) REFERENCES permissions (id),
  CONSTRAINT fk_permission_dependency_requires FOREIGN KEY (requires_permission_id) REFERENCES permissions (id),
  INDEX ix_permission_dependency_sync_version (sync_version)
);

-- Papéis de cliente. organization_id nulo = papel de fábrica (key preenchida, imutável, unique por key no
-- Postgres com índice parcial WHERE organization_id IS NULL). Preenchido = papel próprio da organização.
CREATE TABLE roles (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  organization_id CHAR(36) NULL,
  scope_type ENUM('organization', 'space', 'hub') NOT NULL,
  `key` VARCHAR(50) NULL COMMENT 'só papéis de fábrica: org_admin, org_member, space_reader, space_editor, space_manager, hub_owner, hub_operator, hub_user, hub_room',
  name VARCHAR(255) NOT NULL,
  description VARCHAR(500) NULL COMMENT 'frase simples para a tela (ex.: "Pode ver e conversar")',
  copied_from_role_id CHAR(36) NULL COMMENT 'papel próprio criado duplicando outro; cópia, não herança',
  permissions_reviewed_at DATETIME NULL,
  sync_version BIGINT NOT NULL COMMENT 'versão de sincronização: sequência global do servidor, muda a cada insert/update/exclusão',
  PRIMARY KEY (id),
  -- No Postgres são dois índices únicos parciais (o MySQL não expressa índice parcial):
  --   uq_roles_factory_key (`key`) WHERE organization_id IS NULL            -- papel de fábrica, key única
  --   uq_roles_organization_key (organization_id, `key`) WHERE organization_id IS NOT NULL
  UNIQUE INDEX uq_roles_organization_key (organization_id, `key`),
  INDEX fk_roles_copied_from_idx (copied_from_role_id),
  CONSTRAINT fk_roles_organizations FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_roles_copied_from FOREIGN KEY (copied_from_role_id) REFERENCES roles (id),
  INDEX ix_roles_sync_version (sync_version)
);

CREATE TABLE role_permission (
  role_id CHAR(36) NOT NULL,
  permission_id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  sync_version BIGINT NOT NULL COMMENT 'versão de sincronização: sequência global do servidor, muda a cada insert/update/exclusão',
  PRIMARY KEY (role_id, permission_id),
  INDEX fk_role_permission_permissions_idx (permission_id),
  CONSTRAINT fk_role_permission_roles FOREIGN KEY (role_id) REFERENCES roles (id),
  CONSTRAINT fk_role_permission_permissions FOREIGN KEY (permission_id) REFERENCES permissions (id),
  INDEX ix_role_permission_sync_version (sync_version)
);

-- Quem tem qual papel em qual escopo.
-- Quem: um usuário, a "sala" de um hub (quem está presente sem login) OU uma instalação de app — exatamente um.
-- Onde: exatamente um de organization_id / space_id / hub_id, conforme scope_type.
-- Ex.: "Ana é Editora no espaço Manuais"; "a sala do Hub da recepção é Leitora no espaço Manuais".
-- Ter memory.read num espaço anda junto com uma cópia trancada da chave (space_key_grants).
-- Escopo de espaço (scope_type = 'space'): space_id preenchido, user_id = o membro, role_id = papel de espaço.
-- No Postgres: índice único parcial (space_id, user_id) WHERE scope_type = 'space' AND deleted_at IS NULL —
-- no máximo uma atribuição ativa por pessoa em cada espaço (MySQL não expressa índice parcial) — e o CHECK
-- ck_role_assignments_space_id_scope (scope_type = 'space' OR space_id IS NULL): só linha de espaço leva space_id.
-- Escopo de Hub (scope_type = 'hub'): hub_id preenchido e organization_id NULO (o Hub não é de organização; papéis
-- hub_*). Por isso o RLS ganha uma policy própria: o dono do Hub lê e grava, o próprio Hub (app.hub_id) lê e
-- só grava lápide em papel atribuível (hub_operator/hub_user; cascatas que agem sobre o Hub) e cada usuário lê a
-- própria linha (self_read). No Postgres: CHECKs
-- ck_role_assignments_hub_scope (scope_type <> 'hub' OR (hub_id NOT NULL AND organization_id NULL)) e
-- ck_role_assignments_hub_id_scope (scope_type = 'hub' OR hub_id IS NULL); únicos parciais
-- uq_role_assignments_hub_user (hub_id, user_id) e uq_role_assignments_hub_room (hub_id, room_hub_id), ambos
-- WHERE scope_type = 'hub' AND deleted_at IS NULL (o da Sala também room_hub_id IS NOT NULL).
-- Sala (room_hub_id): o "quem" é a Sala do Hub, com escopo de espaço (papel da Sala no espaço liberado) ou de Hub.
-- No Postgres: índice único parcial uq_role_assignments_space_room_hub (space_id, room_hub_id) WHERE
-- scope_type = 'space' AND room_hub_id IS NOT NULL AND deleted_at IS NULL — no máximo uma liberação ativa na Sala
-- de cada Hub por espaço (o índice de pessoa não cobre: user_id nulo nunca colide).
CREATE TABLE role_assignments (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  role_id CHAR(36) NOT NULL,
  user_id CHAR(36) NULL,
  room_hub_id CHAR(36) NULL,
  app_installation_id CHAR(36) NULL,
  scope_type ENUM('organization', 'space', 'hub') NOT NULL,
  organization_id CHAR(36) NULL,
  space_id CHAR(36) NULL COMMENT 'só em scope_type = space (CHECK ck_role_assignments_space_id_scope no Postgres)',
  hub_id CHAR(36) NULL,
  granted_by_user_id CHAR(36) NULL COMMENT 'quem atribuiu. Em espaço, em geral um Gestor de dentro; exceções auditadas: reabertura pelo kit e promover Gestor gravam o admin de fora',
  approval_status ENUM('not_required', 'pending', 'approved', 'rejected') NOT NULL DEFAULT 'not_required' COMMENT 'papel de instalação num hub: o dono do hub aprova; só vale quando approved',
  approved_by_user_id CHAR(36) NULL,
  approved_at DATETIME NULL,
  sync_version BIGINT NOT NULL COMMENT 'versão de sincronização: sequência global do servidor, muda a cada insert/update/exclusão',
  PRIMARY KEY (id),
  INDEX fk_role_assignments_roles_idx (role_id),
  INDEX ix_role_assignments_user_scope (user_id, scope_type),
  INDEX fk_role_assignments_room_hub_idx (room_hub_id),
  INDEX fk_role_assignments_organizations_idx (organization_id),
  INDEX fk_role_assignments_spaces_idx (space_id, organization_id),
  INDEX fk_role_assignments_hubs_idx (hub_id),
  INDEX fk_role_assignments_granted_by_idx (granted_by_user_id),
  INDEX fk_role_assignments_app_installations_idx (app_installation_id),
  INDEX fk_role_assignments_approved_by_idx (approved_by_user_id),
  UNIQUE INDEX uq_role_assignments_space_room_hub (space_id, room_hub_id) COMMENT 'Postgres: parcial WHERE scope_type = space AND room_hub_id IS NOT NULL AND deleted_at IS NULL',
  UNIQUE INDEX uq_role_assignments_hub_user (hub_id, user_id) COMMENT 'Postgres: parcial WHERE scope_type = hub AND deleted_at IS NULL',
  UNIQUE INDEX uq_role_assignments_hub_room (hub_id, room_hub_id) COMMENT 'Postgres: parcial WHERE scope_type = hub AND room_hub_id IS NOT NULL AND deleted_at IS NULL',
  CONSTRAINT fk_role_assignments_roles FOREIGN KEY (role_id) REFERENCES roles (id),
  CONSTRAINT fk_role_assignments_users FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_role_assignments_room_hub FOREIGN KEY (room_hub_id) REFERENCES hubs (id),
  CONSTRAINT fk_role_assignments_organizations FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_role_assignments_spaces FOREIGN KEY (space_id, organization_id) REFERENCES spaces (id, organization_id),
  CONSTRAINT fk_role_assignments_hubs FOREIGN KEY (hub_id) REFERENCES hubs (id),
  CONSTRAINT fk_role_assignments_granted_by FOREIGN KEY (granted_by_user_id) REFERENCES users (id),
  CONSTRAINT fk_role_assignments_app_installations FOREIGN KEY (app_installation_id) REFERENCES app_installations (id),
  CONSTRAINT fk_role_assignments_approved_by FOREIGN KEY (approved_by_user_id) REFERENCES users (id),
  INDEX ix_role_assignments_sync_version (sync_version)
);

-- Pendência de trancar a chave do espaço para quem foi indicado por convite e já aceitou: a pessoa já tem conta,
-- chave pública e vínculo com a organização; falta um Gestor trancar a chave (todas as versões) para ela.
-- Só do backend (não sincroniza com hub/app).
CREATE TABLE space_pending_grants (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  organization_id CHAR(36) NOT NULL,
  space_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  role_id CHAR(36) NOT NULL,
  invitation_id CHAR(36) NULL,
  requested_by_user_id CHAR(36) NULL,
  status ENUM('pending', 'granted', 'declined', 'cancelled') NOT NULL DEFAULT 'pending',
  PRIMARY KEY (id),
  -- No Postgres: uq_space_pending_grants_open (space_id, user_id) WHERE status = 'pending' AND deleted_at IS NULL
  -- (uma pendência aberta por pessoa em cada espaço; as resolvidas ficam de histórico).
  INDEX uq_space_pending_grants_open (space_id, user_id),
  INDEX fk_space_pending_grants_organizations_idx (organization_id),
  INDEX fk_space_pending_grants_spaces_idx (space_id, organization_id),
  INDEX fk_space_pending_grants_users_idx (user_id),
  INDEX fk_space_pending_grants_roles_idx (role_id),
  INDEX fk_space_pending_grants_invitations_idx (invitation_id, organization_id),
  INDEX fk_space_pending_grants_requested_by_idx (requested_by_user_id),
  CONSTRAINT fk_space_pending_grants_organizations FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_space_pending_grants_spaces FOREIGN KEY (space_id, organization_id) REFERENCES spaces (id, organization_id),
  CONSTRAINT fk_space_pending_grants_users FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_space_pending_grants_roles FOREIGN KEY (role_id) REFERENCES roles (id),
  CONSTRAINT fk_space_pending_grants_invitations FOREIGN KEY (invitation_id, organization_id) REFERENCES organization_invitations (id, organization_id),
  CONSTRAINT fk_space_pending_grants_requested_by FOREIGN KEY (requested_by_user_id) REFERENCES users (id)
);

-- Espaços indicados num convite (com o papel em cada um). Só do backend (não sincroniza com hub/app).
CREATE TABLE invitation_space_intents (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  organization_id CHAR(36) NOT NULL,
  invitation_id CHAR(36) NOT NULL,
  space_id CHAR(36) NOT NULL,
  role_id CHAR(36) NOT NULL,
  -- Quem indicou o espaço (Gestor dele); vira space_pending_grants.requested_by_user_id no aceite.
  requested_by_user_id CHAR(36) NULL,
  PRIMARY KEY (id),
  UNIQUE INDEX uq_invitation_space_intents_invitation_space (invitation_id, space_id),
  INDEX fk_invitation_space_intents_organizations_idx (organization_id),
  INDEX fk_invitation_space_intents_invitations_idx (invitation_id, organization_id),
  INDEX fk_invitation_space_intents_spaces_idx (space_id, organization_id),
  INDEX fk_invitation_space_intents_roles_idx (role_id),
  INDEX fk_invitation_space_intents_requested_by_idx (requested_by_user_id),
  CONSTRAINT fk_invitation_space_intents_organizations FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_invitation_space_intents_invitations FOREIGN KEY (invitation_id, organization_id) REFERENCES organization_invitations (id, organization_id),
  CONSTRAINT fk_invitation_space_intents_spaces FOREIGN KEY (space_id, organization_id) REFERENCES spaces (id, organization_id),
  CONSTRAINT fk_invitation_space_intents_roles FOREIGN KEY (role_id) REFERENCES roles (id),
  CONSTRAINT fk_invitation_space_intents_requested_by FOREIGN KEY (requested_by_user_id) REFERENCES users (id)
);

-- Índice do backup cifrado dos espaços (módulo storage; spec storage-backup §4.1). O S3 só guarda bytes: o índice é a
-- verdade (toda leitura usa s3_version_id). Só ids, tamanho, sha256 do blob cifrado, versão da chave e datas: nunca
-- nome, tipo ou caminho de arquivo. Não entra na sincronização do Hub (sem sync_version; ele lista pelo endpoint do
-- índice). As duas tabelas se referenciam (current_version_id): as FKs entram depois das tabelas.
-- RLS por organização; o runtime não tem DELETE (limpeza física depois da lixeira é rotina futura com o dono).
CREATE TABLE storage_objects (
  id CHAR(36) NOT NULL COMMENT 'objectId gerado pelo Hub (uuid v7), sem default',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL COMMENT 'carimbado com o relógio do banco depois do trabalho no S3: base do since da listagem',
  deleted_at DATETIME NULL COMMENT 'lápide = apagado; a última versão fica em current_version_id (lixeira de 30 dias)',
  organization_id CHAR(36) NOT NULL,
  space_id CHAR(36) NOT NULL,
  current_version_id CHAR(36) NULL COMMENT 'última versão confirmada (committed)',
  PRIMARY KEY (id),
  UNIQUE INDEX uq_storage_objects_id_organization (id, organization_id) COMMENT 'alvo das FKs compostas (filho_id, organization_id)',
  INDEX fk_storage_objects_organizations_idx (organization_id),
  INDEX fk_storage_objects_spaces_idx (space_id),
  INDEX fk_storage_objects_current_version_idx (current_version_id),
  CONSTRAINT fk_storage_objects_organizations FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_storage_objects_spaces FOREIGN KEY (space_id, organization_id) REFERENCES spaces (id, organization_id),
  CONSTRAINT fk_storage_objects_current_version FOREIGN KEY (current_version_id, organization_id) REFERENCES storage_object_versions (id, organization_id)
);

-- Uma linha por intenção de envio (id = uploadId): pending (reserva o tamanho até upload_expires_at), committed (com
-- s3_version_id), expired ou purged (confirmada e apagada de vez da lixeira: o Gestor esvaziou, ou passou do limite de
-- 10 versões antigas por objeto; sai do uso, das listagens e dos downloads). superseded_at = foi para a lixeira (30
-- dias). Quem enviou: um Hub OU uma pessoa (CHECK num_nonnulls = 1). CHECKs no Postgres: status, size_bytes > 0,
-- key_version >= 1, sha256 ~ '^[0-9a-f]{64}$', (status IN ('committed', 'purged')) = (s3_version_id e committed_at
-- preenchidos), (status = 'purged') = (purged_at e superseded_at preenchidos).
CREATE TABLE storage_object_versions (
  id CHAR(36) NOT NULL COMMENT 'uuid v7 do servidor = uploadId',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  organization_id CHAR(36) NOT NULL,
  space_id CHAR(36) NOT NULL,
  object_id CHAR(36) NOT NULL,
  key_version INT NOT NULL COMMENT 'versão da chave do espaço com que o blob foi cifrado',
  size_bytes BIGINT NOT NULL COMMENT 'tamanho do blob cifrado (até 5 GiB)',
  sha256 CHAR(64) NOT NULL COMMENT 'hash do blob cifrado, hexadecimal minúsculo',
  status ENUM('pending', 'committed', 'expired', 'purged') NOT NULL DEFAULT 'pending',
  replaces_version_id CHAR(36) NULL COMMENT 'versão que esta substitui (controle de conflito)',
  s3_version_id VARCHAR(1024) NULL COMMENT 'id da versão no S3; toda leitura usa este',
  uploaded_by_hub_id CHAR(36) NULL,
  uploaded_by_user_id CHAR(36) NULL,
  upload_expires_at DATETIME NOT NULL COMMENT 'fim da reserva e da janela de confirmação (24 h)',
  committed_at DATETIME NULL,
  superseded_at DATETIME NULL COMMENT 'foi para a lixeira (30 dias)',
  purged_at DATETIME NULL COMMENT 'apagada de vez da lixeira (status purged), relógio do banco',
  s3_write_started_at DATETIME NULL COMMENT 'diário: uma gravação no S3 começou neste instante ou depois (relógio do banco); só a varredura storage:reconcile limpa, depois de 60 min',
  PRIMARY KEY (id),
  UNIQUE INDEX uq_storage_object_versions_id_organization (id, organization_id) COMMENT 'alvo das FKs compostas (filho_id, organization_id)',
  INDEX fk_storage_object_versions_organizations_idx (organization_id),
  INDEX fk_storage_object_versions_objects_idx (object_id),
  INDEX fk_storage_object_versions_replaces_idx (replaces_version_id),
  INDEX fk_storage_object_versions_hubs_idx (uploaded_by_hub_id),
  INDEX fk_storage_object_versions_users_idx (uploaded_by_user_id),
  INDEX ix_storage_object_versions_space_status (space_id, status) COMMENT 'uso do espaço (soma por status)',
  INDEX ix_storage_object_versions_s3_write_started (s3_write_started_at) COMMENT 'só linhas marcadas (WHERE s3_write_started_at IS NOT NULL no Postgres)',
  CONSTRAINT fk_storage_object_versions_organizations FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_storage_object_versions_spaces FOREIGN KEY (space_id, organization_id) REFERENCES spaces (id, organization_id),
  CONSTRAINT fk_storage_object_versions_objects FOREIGN KEY (object_id, organization_id) REFERENCES storage_objects (id, organization_id),
  CONSTRAINT fk_storage_object_versions_replaces FOREIGN KEY (replaces_version_id, organization_id) REFERENCES storage_object_versions (id, organization_id),
  CONSTRAINT fk_storage_object_versions_hubs FOREIGN KEY (uploaded_by_hub_id) REFERENCES hubs (id),
  CONSTRAINT fk_storage_object_versions_users FOREIGN KEY (uploaded_by_user_id) REFERENCES users (id)
);

-- ---------------------------------------------------------------------------------------------------
-- Conversas (assuntos) do copiloto (módulo conversations; spec 2026-11-09-conversations)
-- ---------------------------------------------------------------------------------------------------

-- Assunto de um espaço, cifrado com chave própria (versões). O backend só vê metadado: ids, dono, executor, estado,
-- horários e versões; título e plano vivem em encrypted_header. RLS: organização E (app.user_id em
-- participant_user_ids OU executor_hub_id = app.hub_id), por policies restritivas (matriz na migration
-- CreateConversations). participant_user_ids é derivado das participações vivas por trigger (a policy não consulta
-- outra tabela: sem recursão) e nunca é gravado pela aplicação. CHECKs no Postgres: state na lista,
-- current_key_version >= 1, encrypted_header e header_key_version juntos (1..current_key_version), cabeçalho até
-- 16 KiB (21846 caracteres base64url), moved_from_conversation_id <> id.
CREATE TABLE conversations (
  id CHAR(36) NOT NULL COMMENT 'gerado no aparelho (uuid v7; entra no AD da cifra), sem default',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL COMMENT 'lápide: o cabeçalho cifrado fica 30 dias e depois a retenção o zera',
  organization_id CHAR(36) NOT NULL,
  space_id CHAR(36) NOT NULL,
  created_by_user_id CHAR(36) NOT NULL,
  owner_user_id CHAR(36) NOT NULL COMMENT 'dono atual (arquiva, tira participantes, troca o executor, move)',
  executor_hub_id CHAR(36) NULL COMMENT 'Hub onde o copiloto trabalha; o dono dele participa; nulo = sem executor',
  state ENUM('aviso', 'trabalhando', 'na_fila', 'pede_sim', 'esperando_pc', 'concluido', 'arquivado') NOT NULL,
  last_message_at DATETIME NULL,
  current_key_version INT NOT NULL DEFAULT 1,
  key_rotation_required TINYINT NOT NULL DEFAULT 0 COMMENT 'alguém saiu: mensagem nova só depois da troca da chave',
  encrypted_header TEXT NULL COMMENT 'título, plano...: cifrado com a chave do assunto; nulo só depois da retenção',
  header_key_version INT NULL,
  moved_from_conversation_id CHAR(36) NULL COMMENT 'link por id para o assunto de origem (pode ser de outra organização), sem FK',
  participant_user_ids JSON NOT NULL COMMENT 'uuid[] no Postgres: participantes vivos, derivado por trigger (base do RLS)',
  sync_version BIGINT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE INDEX uq_conversations_id_organization (id, organization_id) COMMENT 'alvo das FKs compostas (filho_id, organization_id)',
  INDEX fk_conversations_organizations_idx (organization_id),
  INDEX fk_conversations_spaces_idx (space_id),
  INDEX fk_conversations_created_by_idx (created_by_user_id),
  INDEX fk_conversations_owner_idx (owner_user_id),
  INDEX fk_conversations_executor_hub_idx (executor_hub_id),
  INDEX ix_conversations_sync_version (sync_version),
  CONSTRAINT fk_conversations_organizations FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_conversations_spaces FOREIGN KEY (space_id, organization_id) REFERENCES spaces (id, organization_id),
  CONSTRAINT fk_conversations_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id),
  CONSTRAINT fk_conversations_owner FOREIGN KEY (owner_user_id) REFERENCES users (id),
  CONSTRAINT fk_conversations_executor_hub FOREIGN KEY (executor_hub_id) REFERENCES hubs (id)
);

-- Participação de uma pessoa (até 50 vivas). Sair = lápide; quem volta reaproveita a linha. Visível a quem vê o
-- assunto e, depois de sair, só a própria linha (a sincronização dela recebe a lápide).
CREATE TABLE conversation_participants (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  organization_id CHAR(36) NOT NULL,
  conversation_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  joined_at DATETIME NOT NULL COMMENT 'o mais antigo vira dono quando o dono sai',
  sync_version BIGINT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE INDEX uq_conversation_participants_live (conversation_id, user_id, deleted_at) COMMENT 'uma viva por pessoa (WHERE deleted_at IS NULL no Postgres)',
  INDEX fk_conversation_participants_organizations_idx (organization_id),
  INDEX fk_conversation_participants_conversations_idx (conversation_id),
  INDEX fk_conversation_participants_users_idx (user_id),
  INDEX ix_conversation_participants_sync_version (sync_version),
  CONSTRAINT fk_conversation_participants_organizations FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_conversation_participants_conversations FOREIGN KEY (conversation_id, organization_id) REFERENCES conversations (id, organization_id),
  CONSTRAINT fk_conversation_participants_users FOREIGN KEY (user_id) REFERENCES users (id)
);

-- Cópia trancada de uma versão da chave do assunto (0x01 ‖ crypto_box_seal, 108 caracteres) para UMA pessoa OU o
-- Hub executor (CHECK num_nonnulls = 1); nunca para o kit da organização (privado é privado). Todo participante e o
-- executor têm cópia de todas as versões.
CREATE TABLE conversation_key_grants (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  organization_id CHAR(36) NOT NULL,
  conversation_id CHAR(36) NOT NULL,
  key_version INT NOT NULL,
  user_id CHAR(36) NULL,
  hub_id CHAR(36) NULL,
  wrapped_key VARCHAR(108) NOT NULL COMMENT 'CHECK ~ ^[A-Za-z0-9_-]{108}$',
  sync_version BIGINT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE INDEX uq_conversation_key_grants_user (conversation_id, key_version, user_id, deleted_at) COMMENT 'WHERE user_id IS NOT NULL AND deleted_at IS NULL no Postgres',
  UNIQUE INDEX uq_conversation_key_grants_hub (conversation_id, key_version, hub_id, deleted_at) COMMENT 'WHERE hub_id IS NOT NULL AND deleted_at IS NULL no Postgres',
  INDEX fk_conversation_key_grants_organizations_idx (organization_id),
  INDEX fk_conversation_key_grants_conversations_idx (conversation_id),
  INDEX fk_conversation_key_grants_users_idx (user_id),
  INDEX fk_conversation_key_grants_hubs_idx (hub_id),
  INDEX ix_conversation_key_grants_sync_version (sync_version),
  CONSTRAINT fk_conversation_key_grants_organizations FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_conversation_key_grants_conversations FOREIGN KEY (conversation_id, organization_id) REFERENCES conversations (id, organization_id),
  CONSTRAINT fk_conversation_key_grants_users FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_conversation_key_grants_hubs FOREIGN KEY (hub_id) REFERENCES hubs (id)
);

-- Mensagem imutável (id do aparelho; reenviar o mesmo id não duplica). Autor: uma pessoa OU o Hub executor. Caixa de
-- entrada: a de pessoa nasce pending até o executor confirmar (acked_at); a do executor nasce confirmada. Apagar =
-- lápide; o corpo cifrado fica 30 dias e depois a retenção o zera (body_bytes fica). CHECKs no Postgres: um autor,
-- key_version >= 1, body_bytes 1..65536 e igual ao tamanho do corpo, corpo nulo só com lápide, pending = (acked_at
-- nulo), mensagem do Hub nunca pending, replaces_message_id <> id.
CREATE TABLE conversation_messages (
  id CHAR(36) NOT NULL COMMENT 'gerado no aparelho (uuid v7; entra no AD da cifra), sem default',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  organization_id CHAR(36) NOT NULL,
  conversation_id CHAR(36) NOT NULL,
  author_user_id CHAR(36) NULL,
  author_hub_id CHAR(36) NULL,
  key_version INT NOT NULL,
  encrypted_body TEXT NULL COMMENT 'até 64 KiB cifrados (maior vira anexo); nulo só depois da retenção',
  body_bytes INT NOT NULL COMMENT 'tamanho do blob cifrado: conta no uso do espaço',
  replaces_message_id CHAR(36) NULL COMMENT 'edição = mensagem nova que referencia a anterior (mesma conversa)',
  pending TINYINT NOT NULL,
  acked_at DATETIME NULL,
  sent_at DATETIME NOT NULL,
  sync_version BIGINT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE INDEX uq_conversation_messages_id_conversation (id, conversation_id, organization_id) COMMENT 'alvo das FKs compostas da edição e dos anexos',
  INDEX fk_conversation_messages_organizations_idx (organization_id),
  INDEX fk_conversation_messages_conversations_idx (conversation_id),
  INDEX fk_conversation_messages_author_users_idx (author_user_id),
  INDEX fk_conversation_messages_author_hubs_idx (author_hub_id),
  INDEX fk_conversation_messages_replaces_idx (replaces_message_id),
  INDEX ix_conversation_messages_pending (conversation_id) COMMENT 'caixa de entrada (WHERE pending AND deleted_at IS NULL no Postgres)',
  INDEX ix_conversation_messages_sync_version (sync_version),
  CONSTRAINT fk_conversation_messages_organizations FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_conversation_messages_conversations FOREIGN KEY (conversation_id, organization_id) REFERENCES conversations (id, organization_id),
  CONSTRAINT fk_conversation_messages_author_users FOREIGN KEY (author_user_id) REFERENCES users (id),
  CONSTRAINT fk_conversation_messages_author_hubs FOREIGN KEY (author_hub_id) REFERENCES hubs (id),
  CONSTRAINT fk_conversation_messages_replaces FOREIGN KEY (replaces_message_id, conversation_id, organization_id) REFERENCES conversation_messages (id, conversation_id, organization_id)
);

-- Índice dos anexos cifrados (id do aparelho; objeto no S3 em orgs/<orgId>/spaces/<spaceId>/conversations/
-- <conversationId>/<attachmentId>), no mesmo fluxo intenção -> confirmação do backup. Só ids, tamanho, sha256 do blob
-- cifrado, versão da chave e datas: nunca nome ou tipo. CHECKs no Postgres: status, size_bytes 1..104857600 (100 MiB),
-- key_version >= 1, sha256 ~ '^[0-9a-f]{64}$', (status IN ('committed', 'purged')) = (s3_version_id preenchido).
CREATE TABLE conversation_attachments (
  id CHAR(36) NOT NULL COMMENT 'gerado no aparelho (uuid v7; entra no AD da cifra), sem default',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  organization_id CHAR(36) NOT NULL,
  conversation_id CHAR(36) NOT NULL,
  message_id CHAR(36) NULL COMMENT 'mensagem da mesma conversa (FK composta)',
  key_version INT NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256 CHAR(64) NOT NULL,
  status ENUM('pending', 'committed', 'purged') NOT NULL DEFAULT 'pending',
  s3_version_id VARCHAR(1024) NULL,
  s3_write_started_at DATETIME NULL COMMENT 'diário das gravações no S3 (como em storage_object_versions)',
  upload_expires_at DATETIME NOT NULL,
  sync_version BIGINT NOT NULL,
  PRIMARY KEY (id),
  INDEX fk_conversation_attachments_organizations_idx (organization_id),
  INDEX fk_conversation_attachments_conversations_idx (conversation_id),
  INDEX fk_conversation_attachments_messages_idx (message_id),
  INDEX ix_conversation_attachments_s3_write_started (s3_write_started_at) COMMENT 'só linhas marcadas (WHERE s3_write_started_at IS NOT NULL no Postgres)',
  INDEX ix_conversation_attachments_sync_version (sync_version),
  CONSTRAINT fk_conversation_attachments_organizations FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_conversation_attachments_conversations FOREIGN KEY (conversation_id, organization_id) REFERENCES conversations (id, organization_id),
  CONSTRAINT fk_conversation_attachments_messages FOREIGN KEY (message_id, conversation_id, organization_id) REFERENCES conversation_messages (id, conversation_id, organization_id)
);

-- Permissões que o app pode pedir. À instalação só se concede a interseção (app declarou x papel concedido).
CREATE TABLE app_permission (
  app_id CHAR(36) NOT NULL,
  permission_id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  PRIMARY KEY (app_id, permission_id),
  INDEX fk_app_permission_permissions_idx (permission_id),
  CONSTRAINT fk_app_permission_apps FOREIGN KEY (app_id) REFERENCES apps (id),
  CONSTRAINT fk_app_permission_permissions FOREIGN KEY (permission_id) REFERENCES permissions (id)
);

-- ---------------------------------------------------------------------------------------------------
-- Caixa de entrada e auditoria
-- ---------------------------------------------------------------------------------------------------

-- Itens que um integrador manda para um espaço cifrado: cifrados por ele com a chave do espaço, guardados no
-- S3 sem o backend conseguir ler. O hub busca os pendentes, incorpora e passa a ser dono deles.
CREATE TABLE inbox_items (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  space_id CHAR(36) NOT NULL,
  app_installation_id CHAR(36) NOT NULL COMMENT 'origem: a resposta do Valter cita a fonte',
  object_key VARCHAR(1024) NOT NULL COMMENT 'orgs/<orgId>/spaces/<spaceId>/inbox/<id>',
  key_version INT NOT NULL COMMENT 'versão da chave do espaço usada na cifra',
  content_hash VARCHAR(128) NOT NULL,
  size_bytes BIGINT NOT NULL,
  status ENUM('pending', 'ingested', 'expired') NOT NULL DEFAULT 'pending',
  ingested_by_hub_id CHAR(36) NULL,
  ingested_at DATETIME NULL,
  expires_at DATETIME NOT NULL COMMENT '30 dias sem ser incorporado = expira',
  sync_version BIGINT NOT NULL COMMENT 'versão de sincronização: sequência global do servidor, muda a cada insert/update/exclusão',
  PRIMARY KEY (id),
  INDEX fk_inbox_items_spaces_idx (space_id),
  INDEX fk_inbox_items_app_installations_idx (app_installation_id),
  INDEX fk_inbox_items_hubs_idx (ingested_by_hub_id),
  CONSTRAINT fk_inbox_items_spaces FOREIGN KEY (space_id) REFERENCES spaces (id),
  CONSTRAINT fk_inbox_items_app_installations FOREIGN KEY (app_installation_id) REFERENCES app_installations (id),
  CONSTRAINT fk_inbox_items_hubs FOREIGN KEY (ingested_by_hub_id) REFERENCES hubs (id),
  INDEX ix_inbox_items_sync_version (sync_version)
);

-- Toda chamada de integração (e, no futuro, ações sensíveis de usuários). Só se acrescenta; nada é editado.
-- Retenção apaga de vez os registros antigos (prazo no plano).
CREATE TABLE audit_logs (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  organization_id CHAR(36) NOT NULL,
  app_installation_id CHAR(36) NULL,
  user_id CHAR(36) NULL,
  action VARCHAR(100) NOT NULL COMMENT 'ex.: memory.query, inbox.put, hub.camera.photo',
  scope_type ENUM('organization', 'space', 'hub') NULL,
  space_id CHAR(36) NULL,
  hub_id CHAR(36) NULL,
  result ENUM('success', 'denied', 'error', 'hub_offline') NOT NULL,
  ip VARCHAR(45) NULL,
  metadata JSON NULL,
  PRIMARY KEY (id),
  INDEX ix_audit_logs_organization_created (organization_id, created_at),
  INDEX fk_audit_logs_app_installations_idx (app_installation_id),
  INDEX fk_audit_logs_users_idx (user_id),
  INDEX fk_audit_logs_spaces_idx (space_id),
  INDEX fk_audit_logs_hubs_idx (hub_id),
  CONSTRAINT fk_audit_logs_organizations FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_audit_logs_app_installations FOREIGN KEY (app_installation_id) REFERENCES app_installations (id),
  CONSTRAINT fk_audit_logs_users FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_audit_logs_spaces FOREIGN KEY (space_id) REFERENCES spaces (id),
  CONSTRAINT fk_audit_logs_hubs FOREIGN KEY (hub_id) REFERENCES hubs (id)
);

-- ---------------------------------------------------------------------------------------------------
-- Suporte e auditoria da plataforma (só backend; depois de hubs e organizations por causa das FKs)
-- ---------------------------------------------------------------------------------------------------

-- Pedido de suporte da equipe. Quem tem platform.support.execute_alone cria já executado; os demais criam pendente
-- e outra pessoa com platform.support.approve aprova (executa) ou recusa. Pendente vence em 7 dias (expired).
-- Alvo por tipo (CHECK no Postgres): hub_force_deregister = só target_hub_id; org_appoint_admin =
-- target_organization_id + target_user_id. Runtime: SELECT/INSERT/UPDATE, sem DELETE.
CREATE TABLE platform_support_requests (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  type ENUM('hub_force_deregister', 'org_appoint_admin') NOT NULL,
  status ENUM('pending', 'executed', 'rejected', 'expired', 'failed') NOT NULL,
  requested_by_user_id CHAR(36) NOT NULL,
  target_hub_id CHAR(36) NULL,
  target_organization_id CHAR(36) NULL,
  target_user_id CHAR(36) NULL COMMENT 'pessoa nomeada admin (org_appoint_admin)',
  reason TEXT NOT NULL COMMENT 'motivo, obrigatório',
  evidence TEXT NOT NULL COMMENT 'prova: o que foi conferido e as referências, obrigatória',
  decided_by_user_id CHAR(36) NULL,
  decided_at DATETIME NULL,
  decision_note TEXT NULL COMMENT 'motivo da recusa',
  executed_at DATETIME NULL,
  failure_type VARCHAR(100) NULL COMMENT 'type estável do erro quando status = failed',
  expires_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  INDEX ix_platform_support_requests_status_created (status, created_at),
  INDEX fk_platform_support_requests_requested_by_idx (requested_by_user_id),
  INDEX fk_platform_support_requests_decided_by_idx (decided_by_user_id),
  INDEX fk_platform_support_requests_target_hub_idx (target_hub_id),
  INDEX fk_platform_support_requests_target_organization_idx (target_organization_id),
  INDEX fk_platform_support_requests_target_user_idx (target_user_id),
  CONSTRAINT fk_platform_support_requests_requested_by FOREIGN KEY (requested_by_user_id) REFERENCES users (id),
  CONSTRAINT fk_platform_support_requests_target_hub FOREIGN KEY (target_hub_id) REFERENCES hubs (id),
  CONSTRAINT fk_platform_support_requests_target_organization FOREIGN KEY (target_organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_platform_support_requests_target_user FOREIGN KEY (target_user_id) REFERENCES users (id),
  CONSTRAINT fk_platform_support_requests_decided_by FOREIGN KEY (decided_by_user_id) REFERENCES users (id)
);

-- Trilha da equipe, só de acréscimo (runtime: INSERT/SELECT). user_id nulo = comando de linha.
CREATE TABLE platform_audit_logs (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  user_id CHAR(36) NULL,
  action VARCHAR(100) NOT NULL COMMENT 'ex.: platform.role.granted, platform.request.executed',
  support_request_id CHAR(36) NULL,
  target_user_id CHAR(36) NULL,
  target_hub_id CHAR(36) NULL,
  target_organization_id CHAR(36) NULL,
  result ENUM('success', 'denied', 'error') NOT NULL,
  metadata JSON NULL COMMENT 'sem segredo, token ou prova de reautenticação',
  PRIMARY KEY (id),
  INDEX ix_platform_audit_logs_created (created_at),
  INDEX fk_platform_audit_logs_users_idx (user_id),
  INDEX fk_platform_audit_logs_support_requests_idx (support_request_id),
  INDEX fk_platform_audit_logs_target_user_idx (target_user_id),
  INDEX fk_platform_audit_logs_target_hub_idx (target_hub_id),
  INDEX fk_platform_audit_logs_target_organization_idx (target_organization_id),
  CONSTRAINT fk_platform_audit_logs_users FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_platform_audit_logs_support_requests FOREIGN KEY (support_request_id) REFERENCES platform_support_requests (id),
  CONSTRAINT fk_platform_audit_logs_target_user FOREIGN KEY (target_user_id) REFERENCES users (id),
  CONSTRAINT fk_platform_audit_logs_target_hub FOREIGN KEY (target_hub_id) REFERENCES hubs (id),
  CONSTRAINT fk_platform_audit_logs_target_organization FOREIGN KEY (target_organization_id) REFERENCES organizations (id)
);
