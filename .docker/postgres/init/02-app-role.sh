#!/bin/sh
# Cria o papel de grupo e o login de runtime da API (idempotente). Se o login já existe, a senha é
# atualizada para o DB_APP_PASSWORD atual (é assim que se rotaciona a senha). As permissões em si ficam nas
# migrations (concedidas a app_runtime). Roda na criação do banco; para um banco já existente:
#   docker exec vaulter-back-db sh /docker-entrypoint-initdb.d/02-app-role.sh
set -eu

: "${DB_APP_USERNAME:?DB_APP_USERNAME is required}"
: "${DB_APP_PASSWORD:?DB_APP_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_user="$DB_APP_USERNAME" -v app_password="$DB_APP_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE app_runtime NOLOGIN NOBYPASSRLS')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_runtime') \gexec

SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L', :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'app_user') \gexec

SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_password') \gexec

SELECT format('GRANT app_runtime TO %I', :'app_user') \gexec
SQL
