#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
NODE_BIN="${NODE_BIN:-}"
if [[ -z "${NODE_BIN}" ]]; then
  for candidate in \
    "$(command -v node 2>/dev/null || true)" \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node" \
    "${HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
  do
    if [[ -n "${candidate}" && -x "${candidate}" ]]; then
      NODE_BIN="${candidate}"
      break
    fi
  done
fi
if [[ -z "${NODE_BIN}" ]]; then
  echo "node binary not found" >&2
  exit 1
fi
VAULT_HOME="${AI_CHAT_VAULT_HOME:-${HOME}/.ai-chat-vault}"
OUT_DIR="${AI_CHAT_PERSONAL_MEMORY_EXPORT_DIR:-${VAULT_HOME}/personal-ai-memory-imports}"
CHUNK_SIZE="${AI_CHAT_PERSONAL_MEMORY_CHUNK_SIZE:-25000}"
MAX_CONTENT_CHARS="${AI_CHAT_PERSONAL_MEMORY_MAX_CONTENT_CHARS:-4000}"

mkdir -p "${OUT_DIR}" "${VAULT_HOME}/logs"

"${NODE_BIN}" "${REPO_ROOT}/scripts/import-ai-archives.js" \
  --source "${HOME}/Downloads" \
  --source "${HOME}/Desktop" \
  --sync

"${NODE_BIN}" "${REPO_ROOT}/mcp/cli.js" sync --all

rm -f "${OUT_DIR}"/personal-ai-memory-*.json "${OUT_DIR}/manifest.json"

"${NODE_BIN}" "${REPO_ROOT}/scripts/export-personal-ai-memory.js" \
  --out "${OUT_DIR}" \
  --chunk-size "${CHUNK_SIZE}" \
  --max-content-chars "${MAX_CONTENT_CHARS}"
