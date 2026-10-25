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
  -- com hash do servidor) e uma chave que abre encrypted_private_key. Recuperar a senha devolve o login,
  -- não os dados.
  auth_hash VARCHAR(255) NOT NULL,
  kdf_salt VARCHAR(64) NOT NULL,
  kdf_params JSON NOT NULL,
  -- Par de chaves do usuário: com a pública, quem já está num espaço tranca a chave do espaço para ele.
  public_key TEXT NOT NULL,
  encrypted_private_key TEXT NOT NULL,
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
  refresh_token_hash VARCHAR(128) NOT NULL COMMENT 'hash do refresh atual; refresh rotativo, reuso revoga a sessão',
  refresh_expires_at DATETIME NOT NULL COMMENT '30 dias de inatividade, renovado a cada refresh',
  last_used_at DATETIME NOT NULL,
  last_ip VARCHAR(45) NULL,
  user_agent VARCHAR(500) NULL,
  revoked_at DATETIME NULL,
  revoked_reason ENUM('logout', 'revoked', 'refresh_reuse', 'password_change') NULL,
  PRIMARY KEY (id),
  INDEX ix_user_sessions_user (user_id, revoked_at),
  CONSTRAINT fk_user_sessions_users FOREIGN KEY (user_id) REFERENCES users (id)
);

-- Papéis da plataforma (equipe Vaulter: suporte, financeiro...). Separados dos papéis de cliente (roles), que
-- têm escopo de organização/espaço/hub e chegam ao hub; estes ficam só no backend.
CREATE TABLE platform_roles (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  `key` VARCHAR(50) NOT NULL COMMENT 'código fixo usado pelo backend (ex.: support); name é só exibição',
  name VARCHAR(255) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE INDEX uq_platform_roles_key (`key`)
);

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
  plan VARCHAR(50) NOT NULL DEFAULT 'free' COMMENT 'decide se a nuvem ativa está liberada',
  -- Kit de recuperação: a parte privada é mostrada uma vez ao cliente; aqui só a pública, para trancar as
  -- chaves dos espaços (space_keys.recovery_wrapped_key).
  recovery_public_key TEXT NOT NULL,
  sync_version BIGINT NOT NULL COMMENT 'versão de sincronização: sequência global do servidor, muda a cada insert/update/exclusão',
  PRIMARY KEY (id),
  INDEX ix_organizations_sync_version (sync_version)
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

-- ---------------------------------------------------------------------------------------------------
-- Hubs
-- ---------------------------------------------------------------------------------------------------

CREATE TABLE hubs (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  owner_user_id CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  public_key TEXT NOT NULL COMMENT 'para trancar as chaves dos espaços abertos na sala',
  last_seen_at DATETIME NULL,
  sync_version BIGINT NOT NULL COMMENT 'versão de sincronização: sequência global do servidor, muda a cada insert/update/exclusão',
  PRIMARY KEY (id),
  INDEX fk_hubs_users_idx (owner_user_id),
  CONSTRAINT fk_hubs_users FOREIGN KEY (owner_user_id) REFERENCES users (id),
  INDEX ix_hubs_sync_version (sync_version)
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
  sync_version BIGINT NOT NULL COMMENT 'versão de sincronização: sequência global do servidor, muda a cada insert/update/exclusão',
  PRIMARY KEY (id),
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
  space_id CHAR(36) NOT NULL,
  version INT NOT NULL,
  recovery_wrapped_key TEXT NOT NULL COMMENT 'trancada com organizations.recovery_public_key (kit)',
  sync_version BIGINT NOT NULL COMMENT 'versão de sincronização: sequência global do servidor, muda a cada insert/update/exclusão',
  PRIMARY KEY (id),
  UNIQUE INDEX uq_space_keys_space_version (space_id, version),
  CONSTRAINT fk_space_keys_spaces FOREIGN KEY (space_id) REFERENCES spaces (id),
  INDEX ix_space_keys_sync_version (sync_version)
);

-- Cópias trancadas da chave do espaço: uma por pessoa, por hub autorizado ou por instalação de app.
CREATE TABLE space_key_grants (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
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
  INDEX fk_space_key_grants_users_idx (user_id),
  INDEX fk_space_key_grants_hubs_idx (hub_id),
  INDEX fk_space_key_grants_app_installations_idx (app_installation_id),
  CONSTRAINT fk_space_key_grants_space_keys FOREIGN KEY (space_key_id) REFERENCES space_keys (id),
  CONSTRAINT fk_space_key_grants_users FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_space_key_grants_hubs FOREIGN KEY (hub_id) REFERENCES hubs (id),
  CONSTRAINT fk_space_key_grants_app_installations FOREIGN KEY (app_installation_id) REFERENCES app_installations (id),
  INDEX ix_space_key_grants_sync_version (sync_version)
);

-- Vínculo com dois consentimentos: o dono do hub pede; a política da organização decide se precisa de admin.
CREATE TABLE hub_organization (
  hub_id CHAR(36) NOT NULL,
  organization_id CHAR(36) NOT NULL,
  status ENUM('pending', 'approved', 'revoked') NOT NULL DEFAULT 'pending',
  requested_by_user_id CHAR(36) NOT NULL,
  approved_by_user_id CHAR(36) NULL,
  approved_at DATETIME NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  sync_version BIGINT NOT NULL COMMENT 'versão de sincronização: sequência global do servidor, muda a cada insert/update/exclusão',
  PRIMARY KEY (hub_id, organization_id),
  INDEX fk_hub_organization_organizations_idx (organization_id),
  INDEX fk_hub_organization_requested_by_idx (requested_by_user_id),
  INDEX fk_hub_organization_approved_by_idx (approved_by_user_id),
  CONSTRAINT fk_hub_organization_hubs FOREIGN KEY (hub_id) REFERENCES hubs (id),
  CONSTRAINT fk_hub_organization_organizations FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_hub_organization_requested_by FOREIGN KEY (requested_by_user_id) REFERENCES users (id),
  CONSTRAINT fk_hub_organization_approved_by FOREIGN KEY (approved_by_user_id) REFERENCES users (id),
  INDEX ix_hub_organization_sync_version (sync_version)
);

-- Quais espaços estão num hub. Quem usa o quê nele (inclusive a "sala", sem login) vem de role_assignments.
CREATE TABLE hub_space (
  hub_id CHAR(36) NOT NULL,
  space_id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  deleted_at DATETIME NULL,
  updated_at DATETIME NULL,
  sync_version BIGINT NOT NULL COMMENT 'versão de sincronização: sequência global do servidor, muda a cada insert/update/exclusão',
  PRIMARY KEY (hub_id, space_id),
  INDEX fk_hub_space_spaces_idx (space_id),
  CONSTRAINT fk_hub_space_hubs FOREIGN KEY (hub_id) REFERENCES hubs (id),
  CONSTRAINT fk_hub_space_spaces FOREIGN KEY (space_id) REFERENCES spaces (id),
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
  space_id CHAR(36) NULL,
  hub_id CHAR(36) NULL,
  granted_by_user_id CHAR(36) NULL COMMENT 'em espaço: precisa ser alguém de dentro (o admin não se coloca sozinho)',
  approval_status ENUM('not_required', 'pending', 'approved', 'rejected') NOT NULL DEFAULT 'not_required' COMMENT 'papel de instalação num hub: o dono do hub aprova; só vale quando approved',
  approved_by_user_id CHAR(36) NULL,
  approved_at DATETIME NULL,
  sync_version BIGINT NOT NULL COMMENT 'versão de sincronização: sequência global do servidor, muda a cada insert/update/exclusão',
  PRIMARY KEY (id),
  INDEX fk_role_assignments_roles_idx (role_id),
  INDEX ix_role_assignments_user_scope (user_id, scope_type),
  INDEX fk_role_assignments_room_hub_idx (room_hub_id),
  INDEX fk_role_assignments_organizations_idx (organization_id),
  INDEX fk_role_assignments_spaces_idx (space_id),
  INDEX fk_role_assignments_hubs_idx (hub_id),
  INDEX fk_role_assignments_granted_by_idx (granted_by_user_id),
  INDEX fk_role_assignments_app_installations_idx (app_installation_id),
  INDEX fk_role_assignments_approved_by_idx (approved_by_user_id),
  CONSTRAINT fk_role_assignments_roles FOREIGN KEY (role_id) REFERENCES roles (id),
  CONSTRAINT fk_role_assignments_users FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_role_assignments_room_hub FOREIGN KEY (room_hub_id) REFERENCES hubs (id),
  CONSTRAINT fk_role_assignments_organizations FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_role_assignments_spaces FOREIGN KEY (space_id) REFERENCES spaces (id),
  CONSTRAINT fk_role_assignments_hubs FOREIGN KEY (hub_id) REFERENCES hubs (id),
  CONSTRAINT fk_role_assignments_granted_by FOREIGN KEY (granted_by_user_id) REFERENCES users (id),
  CONSTRAINT fk_role_assignments_app_installations FOREIGN KEY (app_installation_id) REFERENCES app_installations (id),
  CONSTRAINT fk_role_assignments_approved_by FOREIGN KEY (approved_by_user_id) REFERENCES users (id),
  INDEX ix_role_assignments_sync_version (sync_version)
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
