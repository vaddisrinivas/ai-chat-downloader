# MCP Context Engine

This fork adds a local-first chat vault on top of the browser exporter.

## Flow

1. Open ChatGPT, Claude, Gemini, Perplexity, Grok, or DeepSeek.
2. Export a chat with the extension.
3. The extension writes both Markdown and normalized JSON to `Downloads/AI_Chats`.
4. Run `npm run sync` or keep `npm run daily` alive.
5. MCP clients can search and build context packs from the local vault.

## Local Store

Default path:

```bash
~/.ai-chat-vault
```

Files:

- `conversations.jsonl`
- `messages.jsonl`
- `sync-state.json`

Override:

```bash
export AI_CHAT_VAULT_HOME=/path/to/vault
export AI_CHAT_EXPORT_DIRS="/path/one:/path/two"
```

## CLI

```bash
npm run sync
node mcp/cli.js import ~/Downloads/AI_Chats/example.json
node mcp/cli.js search "memory gift pricing"
node mcp/cli.js context "memory gift pricing" --max-chars 8000
node mcp/cli.js check
node mcp/cli.js sync --watch-24h
```

## MCP Server

```bash
npm run mcp
```

Tools:

- `sync_exports`
- `import_paths`
- `search_chats`
- `list_conversations`
- `get_conversation`
- `build_context_pack`
- `daily_check`

## Daily Sync

`node mcp/cli.js sync --watch-24h` runs one sync immediately and then once every 24 hours.

This only imports local export files. It does not silently scrape provider websites.

Install a macOS LaunchAgent:

```bash
scripts/install-daily-sync.sh
```

Remove it:

```bash
scripts/uninstall-daily-sync.sh
```
