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
-- Convenção: tabelas de entidade no plural; tabelas de ligação com os dois nomes no singular.

CREATE SCHEMA IF NOT EXISTS vaulter;
USE vaulter;

-- ---------------------------------------------------------------------------------------------------
-- Usuários e papéis da plataforma (ex.: equipe Vaulter)
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
  PRIMARY KEY (id),
  UNIQUE INDEX uq_users_email (email)
);

CREATE TABLE roles (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  `key` VARCHAR(50) NOT NULL COMMENT 'código fixo usado pelo backend (ex.: support); name é só exibição',
  name VARCHAR(255) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE INDEX uq_roles_key (`key`)
);

CREATE TABLE user_role (
  user_id CHAR(36) NOT NULL,
  role_id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (user_id, role_id),
  INDEX fk_user_role_roles_idx (role_id),
  CONSTRAINT fk_user_role_users FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_user_role_roles FOREIGN KEY (role_id) REFERENCES roles (id)
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
  PRIMARY KEY (id)
);

CREATE TABLE organization_roles (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  `key` VARCHAR(50) NOT NULL COMMENT 'admin | member',
  name VARCHAR(255) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE INDEX uq_organization_roles_key (`key`)
);

CREATE TABLE user_organization (
  organization_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  role_id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  deleted_at DATETIME NULL COMMENT 'saiu da organização; os dados ficam nos espaços',
  PRIMARY KEY (organization_id, user_id),
  INDEX fk_user_organization_users_idx (user_id),
  INDEX fk_user_organization_organization_roles_idx (role_id),
  CONSTRAINT fk_user_organization_organizations FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_user_organization_users FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_user_organization_organization_roles FOREIGN KEY (role_id) REFERENCES organization_roles (id)
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
  PRIMARY KEY (id),
  INDEX fk_hubs_users_idx (owner_user_id),
  CONSTRAINT fk_hubs_users FOREIGN KEY (owner_user_id) REFERENCES users (id)
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
  PRIMARY KEY (id),
  INDEX fk_spaces_organizations_idx (organization_id),
  CONSTRAINT fk_spaces_organizations FOREIGN KEY (organization_id) REFERENCES organizations (id)
);

-- Membro do espaço: quem enxerga o conteúdo. O admin da organização só entra se alguém de dentro o adicionar.
CREATE TABLE space_user (
  space_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  added_by_user_id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  deleted_at DATETIME NULL,
  PRIMARY KEY (space_id, user_id),
  INDEX fk_space_user_users_idx (user_id),
  INDEX fk_space_user_added_by_idx (added_by_user_id),
  CONSTRAINT fk_space_user_spaces FOREIGN KEY (space_id) REFERENCES spaces (id),
  CONSTRAINT fk_space_user_users FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_space_user_added_by FOREIGN KEY (added_by_user_id) REFERENCES users (id)
);

-- Uma linha por versão da chave do espaço (troca quando alguém sai). A chave em si nunca fica aberta aqui.
CREATE TABLE space_keys (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  space_id CHAR(36) NOT NULL,
  version INT NOT NULL,
  recovery_wrapped_key TEXT NOT NULL COMMENT 'trancada com organizations.recovery_public_key (kit)',
  PRIMARY KEY (id),
  UNIQUE INDEX uq_space_keys_space_version (space_id, version),
  CONSTRAINT fk_space_keys_spaces FOREIGN KEY (space_id) REFERENCES spaces (id)
);

-- Cópias trancadas da chave do espaço: uma por pessoa e uma por hub autorizado (exatamente um dos dois).
CREATE TABLE space_key_grants (
  id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  space_key_id CHAR(36) NOT NULL,
  user_id CHAR(36) NULL,
  hub_id CHAR(36) NULL,
  wrapped_key TEXT NOT NULL COMMENT 'trancada com a public_key do usuário ou do hub',
  PRIMARY KEY (id),
  UNIQUE INDEX uq_space_key_grants_user (space_key_id, user_id),
  UNIQUE INDEX uq_space_key_grants_hub (space_key_id, hub_id),
  INDEX fk_space_key_grants_users_idx (user_id),
  INDEX fk_space_key_grants_hubs_idx (hub_id),
  CONSTRAINT fk_space_key_grants_space_keys FOREIGN KEY (space_key_id) REFERENCES space_keys (id),
  CONSTRAINT fk_space_key_grants_users FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_space_key_grants_hubs FOREIGN KEY (hub_id) REFERENCES hubs (id)
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
  PRIMARY KEY (hub_id, organization_id),
  INDEX fk_hub_organization_organizations_idx (organization_id),
  INDEX fk_hub_organization_requested_by_idx (requested_by_user_id),
  INDEX fk_hub_organization_approved_by_idx (approved_by_user_id),
  CONSTRAINT fk_hub_organization_hubs FOREIGN KEY (hub_id) REFERENCES hubs (id),
  CONSTRAINT fk_hub_organization_organizations FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_hub_organization_requested_by FOREIGN KEY (requested_by_user_id) REFERENCES users (id),
  CONSTRAINT fk_hub_organization_approved_by FOREIGN KEY (approved_by_user_id) REFERENCES users (id)
);

-- Quais espaços estão num hub, e se ficam abertos na sala (respondem por voz sem login).
CREATE TABLE hub_space (
  hub_id CHAR(36) NOT NULL,
  space_id CHAR(36) NOT NULL,
  open_in_room TINYINT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  PRIMARY KEY (hub_id, space_id),
  INDEX fk_hub_space_spaces_idx (space_id),
  CONSTRAINT fk_hub_space_hubs FOREIGN KEY (hub_id) REFERENCES hubs (id),
  CONSTRAINT fk_hub_space_spaces FOREIGN KEY (space_id) REFERENCES spaces (id)
);
