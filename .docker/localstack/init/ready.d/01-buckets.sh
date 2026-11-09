#!/bin/bash
# Roda toda vez que o LocalStack fica pronto: a versão gratuita não persiste dados entre reinícios.
# O CI roda este mesmo script dentro do serviço LocalStack (docker exec), para o bucket do e2e ser igual ao do compose.
set -euo pipefail

BUCKET="${S3_BUCKET_HUB_BRAIN:-vaulter-hub-brain}"

awslocal s3api head-bucket --bucket "$BUCKET" 2>/dev/null || awslocal s3 mb "s3://$BUCKET"
awslocal s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled

# Ciclo de vida (o mesmo vale para o bucket de produção; o LocalStack guarda a regra, mas não a executa):
# - objects-versions-30d: em orgs/, versões antigas (substituídas ou apagadas) expiram 30 dias depois de deixarem
#   de ser a atual, e o delete marker que fica sozinho (sem versões por baixo) é removido.
# - uploads-1d: o provisório (orgs/<orgId>/spaces/<spaceId>/uploads/<uploadId>) expira em 1 dia. Filtro de ciclo de
#   vida só casa PREFIXO do começo da chave, e "uploads/" fica no meio do caminho; por isso a regra casa a tag
#   stage=upload, que a URL assinada de PUT exige (cabeçalho x-amz-tagging assinado, S3ObjectStore.presignPut). A cópia
#   para objects/ troca as tags (TaggingDirective REPLACE), então o objeto final nunca a carrega. A versão antiga do
#   provisório (depois da expiração vira delete marker) também sai em 1 dia.
awslocal s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration '{
  "Rules": [
    {
      "ID": "objects-versions-30d",
      "Status": "Enabled",
      "Filter": { "Prefix": "orgs/" },
      "Expiration": { "ExpiredObjectDeleteMarker": true },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 30 }
    },
    {
      "ID": "uploads-1d",
      "Status": "Enabled",
      "Filter": { "And": { "Prefix": "orgs/", "Tags": [{ "Key": "stage", "Value": "upload" }] } },
      "Expiration": { "Days": 1 },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 1 }
    }
  ]
}'
