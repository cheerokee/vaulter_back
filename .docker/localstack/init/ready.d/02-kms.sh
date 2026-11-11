#!/bin/bash
# Chave KMS de desenvolvimento que envelopa a chave privada X25519 do servidor (módulo cloud, KmsServerKeyring).
# Roda toda vez que o LocalStack fica pronto: a versão gratuita não persiste dados entre reinícios. O CI roda este
# mesmo script dentro do serviço LocalStack (docker exec).
#
# Id e material FIXOS (tags _custom_id_ e _custom_key_material_ do LocalStack): a cópia cifrada da chave do servidor
# fica no banco (cloud_server_keys), que sobrevive ao reinício do LocalStack; com uma chave KMS nova a cada subida ela
# nunca mais abriria. O material abaixo é público e só de desenvolvimento (32 bytes zero): nada de produção usa isto.
# Em produção a chave é uma chave KMS simétrica real (us-east-1), criada uma vez, com o papel IAM da API podendo
# kms:Encrypt e kms:Decrypt nela; CLOUD_KMS_KEY_ID aponta para o alias.
set -euo pipefail

KEY_ID="00000000-0000-4000-8000-00000000c10d"
ALIAS="${CLOUD_KMS_KEY_ALIAS:-alias/cloud-server-key}"
MATERIAL="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

if ! awslocal kms describe-key --key-id "$KEY_ID" >/dev/null 2>&1; then
  awslocal kms create-key \
    --description "dev envelope key of the server X25519 key" \
    --tags "TagKey=_custom_id_,TagValue=$KEY_ID" "TagKey=_custom_key_material_,TagValue=$MATERIAL" >/dev/null
fi
if ! awslocal kms list-aliases --key-id "$KEY_ID" --query 'Aliases[].AliasName' --output text | grep -qx "$ALIAS"; then
  awslocal kms create-alias --alias-name "$ALIAS" --target-key-id "$KEY_ID"
fi
