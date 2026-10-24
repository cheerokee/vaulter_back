#!/bin/bash
# Roda toda vez que o LocalStack fica pronto: a versão gratuita não persiste dados entre reinícios.
set -euo pipefail

BUCKET=vaulter-hub-brain

awslocal s3api head-bucket --bucket "$BUCKET" 2>/dev/null || awslocal s3 mb "s3://$BUCKET"
awslocal s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
