# MCP Context Engine

This fork adds a local-first chat vault on top of the browser exporter and local assistant history files.

## Flow

1. Browser chats: open ChatGPT, Claude, Gemini, Perplexity, Grok, or DeepSeek and export with the extension.
2. Local agent chats: Codex, Claude Code, Gemini CLI/Antigravity, VS Code Chat, and GitHub Copilot are indexed from their local history files.
3. Run `npm run sync` or keep `npm run daily` alive.
4. MCP clients can search and build context packs from the local vault.

The vault is an index, not a raw-log copy. Bulky tool outputs stay in their original files and are represented by `raw_ref` metadata (`source_file`, `line`, session/tool identifiers).

## Local Store

Default path:

```bash
~/.ai-chat-vault
```

Files:

- `conversations.jsonl`
- `messages.jsonl`
- `sync-state.json`
- `local-sync-state.json`

Override:

```bash
export AI_CHAT_VAULT_HOME=/path/to/vault
export AI_CHAT_EXPORT_DIRS="/path/one:/path/two"
export AI_CHAT_LOCAL_DIRS="/extra/local/source/dir"
```

## CLI

```bash
npm run sync
npm run sync:local
npm run sync:exports
node mcp/cli.js import ~/Downloads/AI_Chats/example.json
node mcp/cli.js search "memory gift pricing"
node mcp/cli.js tools "npm run test" --tool exec_command --limit 10
node mcp/cli.js tool-stats --provider codex
node mcp/cli.js context "memory gift pricing" --max-chars 8000
node mcp/cli.js raw ~/.codex/sessions/2026/.../rollout.jsonl --line 1234
npm run export:personal-ai-memory -- --dry-run
npm run export:personal-ai-memory -- --out ~/.ai-chat-vault/exports/personal-ai-memory.json
npm run export:personal-ai-memory -- --out ~/.ai-chat-vault/personal-ai-memory-imports --chunk-size 25000 --max-content-chars 4000
npm run sync:personal-ai-memory
node mcp/cli.js check
node mcp/cli.js sync --all --watch-24h
```

`sync --all` combines browser export import with local source indexing. `sync --local` only indexes local assistant histories by reference.

## Personal AI Memory Bridge

Generate an importable Personal AI Memory Layer backup from the local vault:

```bash
npm run sync
npm run export:personal-ai-memory -- --dry-run
npm run export:personal-ai-memory -- --out ~/.ai-chat-vault/exports/personal-ai-memory.json
npm run export:personal-ai-memory -- --out ~/.ai-chat-vault/personal-ai-memory-imports --chunk-size 25000 --max-content-chars 4000
```

The exporter emits:

- `metadata.app = "PersonalAIMemoryLayer"`
- `metadata.version = "1.2"`
- one payload record per vault message
- Codex/Claude/Gemini/Copilot/tool-call metadata under `record.metadata`
- `rawRef` pointers for messages that should resolve back to original local source files

Default mode maps providers to upstream-compatible Personal AI Memory values: `openai`, `anthropic`, `google`, `xai`, and `perplexity`. Use `--extended-providers` only if your fork accepts providers such as `codex`, `github-copilot`, and `vscode-chat`.

Generated export files are private data. Keep them under `~/.ai-chat-vault/exports` or another local-only path; do not commit them to GitHub.

For hourly refreshes of the Personal AI Memory import chunks:

```bash
scripts/install-personal-ai-memory-sync.sh
```

This installs `com.ai-chat-vault.personal-ai-memory-sync`, which runs `scripts/sync-personal-ai-memory.sh` at load and every hour. It regenerates chunked import files under `~/.ai-chat-vault/personal-ai-memory-imports`.

## MCP Server

```bash
npm run mcp
```

Tools:

- `sync_exports`
- `sync_local_sources`
- `sync_all_sources`
- `read_raw_ref`
- `import_paths`
- `search_chats`
- `search_tool_calls`
- `tool_call_stats`
- `list_conversations`
- `get_conversation`
- `build_context_pack`
- `daily_check`

## Daily Sync

`node mcp/cli.js sync --all --watch-24h` runs one sync immediately and then once every 24 hours.

This imports local export files and indexes local assistant history files. It does not silently scrape provider websites.

Install a macOS LaunchAgent:

```bash
scripts/install-daily-sync.sh
```

Remove it:

```bash
scripts/uninstall-daily-sync.sh
```
