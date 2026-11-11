#!/bin/sh
# Serviço de embeddings (módulo cloud): Ollama com o mesmo modelo do Hub (nomic-embed-text, tag v1.5 = id 0a109f422b47).
# Sobe o servidor, baixa o modelo se ainda não está no volume (.docker/ollama/models) e fica em primeiro plano.
set -eu
MODEL="${EMBEDDING_MODEL:-nomic-embed-text:v1.5}"

ollama serve &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' TERM INT

until ollama list >/dev/null 2>&1; do sleep 1; done
if ! ollama list | grep -q "^${MODEL}"; then
  echo "pulling ${MODEL}"
  ollama pull "${MODEL}"
fi
echo "ready: ${MODEL}"
wait "$SERVER_PID"
