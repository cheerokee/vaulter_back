#!/bin/sh
# Drift check: as entidades TypeORM têm de descrever exatamente o schema que as migrations criaram.
# Roda o `schema:log` do CLI (o SQL que a sincronização executaria) contra o banco do .env/ambiente
# (DB_DATABASE, já migrado) e falha se ele imprimir qualquer SQL — ou se o próprio comando falhar.
# Diferença = falta migration (ou a entidade não declara uma constraint/índice que a migration criou).
out=$(npm run --silent typeorm -- schema:log 2>&1)
code=$?
printf '%s\n' "$out"
if [ "$code" -ne 0 ]; then
  echo "schema:check: schema:log failed (exit $code)" >&2
  exit 1
fi
if ! printf '%s\n' "$out" | grep -q 'Your schema is up to date'; then
  echo "schema:check: entities and database differ — write a migration (npm run migration:generate)" >&2
  exit 1
fi
echo "schema:check: OK, no drift"
