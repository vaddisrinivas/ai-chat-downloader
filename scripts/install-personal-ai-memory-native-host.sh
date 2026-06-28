#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_NAME="com.ai_chat_vault.host"
EXTENSION_ID="${PERSONAL_AI_MEMORY_EXTENSION_ID:-ahcaaiangeombkijologmolpejajacpg}"
HOST_DIR="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
HOST_MANIFEST="${HOST_DIR}/${HOST_NAME}.json"
HOST_SCRIPT="${SCRIPT_DIR}/personal-ai-memory-native-host.js"

mkdir -p "${HOST_DIR}"
chmod +x "${HOST_SCRIPT}"

cat > "${HOST_MANIFEST}" <<JSON
{
  "name": "${HOST_NAME}",
  "description": "Local AI Chat Vault bridge for Personal AI Memory",
  "path": "${HOST_SCRIPT}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXTENSION_ID}/"
  ]
}
JSON

echo "${HOST_MANIFEST}"

