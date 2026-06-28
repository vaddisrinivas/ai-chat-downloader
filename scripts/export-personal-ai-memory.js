#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STORE_HOME = process.env.AI_CHAT_VAULT_HOME || path.join(os.homedir(), '.ai-chat-vault');
const CONVERSATIONS_FILE = path.join(STORE_HOME, 'conversations.jsonl');
const MESSAGES_FILE = path.join(STORE_HOME, 'messages.jsonl');

function usage() {
  return `Usage:
  node scripts/export-personal-ai-memory.js [--out <file>] [--provider <name>] [--limit <n>]
    [--max-content-chars <n>] [--chunk-size <n>] [--no-tools] [--extended-providers] [--dry-run]

Exports ~/.ai-chat-vault into Personal AI Memory Layer backup JSON.
  Default output: ~/.ai-chat-vault/exports/personal-ai-memory-<timestamp>.json
  Chunked output: pass --chunk-size and --out <directory>

Notes:
  --extended-providers preserves providers such as codex/github-copilot/vscode-chat.
  Default mode maps providers to upstream-compatible values:
  openai, anthropic, google, xai, perplexity.
`;
}

function parseArgs(argv) {
  const options = {
    out: null,
    providers: [],
    limit: null,
    includeTools: true,
    maxContentChars: Number(process.env.AI_CHAT_VAULT_PAM_MAX_CHARS || 12000),
    chunkSize: null,
    extendedProviders: false,
    dryRun: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else if (arg === '--out') {
      options.out = argv[++index];
    } else if (arg === '--provider') {
      options.providers.push(normalizeProvider(argv[++index]));
    } else if (arg === '--limit') {
      options.limit = Number(argv[++index]);
    } else if (arg === '--max-content-chars') {
      options.maxContentChars = Number(argv[++index]);
    } else if (arg === '--chunk-size') {
      options.chunkSize = Number(argv[++index]);
    } else if (arg === '--no-tools') {
      options.includeTools = false;
    } else if (arg === '--extended-providers') {
      options.extendedProviders = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line) => JSON.parse(line));
}

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase();
}

function personalMemoryProvider(provider, extendedProviders) {
  const value = normalizeProvider(provider);
  if (extendedProviders) return value || 'unknown';
  if (value === 'claude' || value === 'anthropic') return 'anthropic';
  if (value === 'gemini' || value === 'google') return 'google';
  if (value === 'grok' || value === 'xai') return 'xai';
  if (value === 'perplexity') return 'perplexity';
  return 'openai';
}

function timestampMs(value, fallback = Date.now()) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? fallback : parsed;
}

function isToolMessage(message) {
  const displayRole = String(message.display_role || '').toLowerCase();
  const content = String(message.content || '');
  return message.role === 'tool'
    || displayRole.startsWith('tool')
    || content.startsWith('[tool_call]')
    || content.startsWith('[tool_result]');
}

function toolKindFor(message) {
  const displayRole = String(message.display_role || '').toLowerCase();
  const content = String(message.content || '');
  if (content.startsWith('[tool_call]') || displayRole.startsWith('tool call')) return 'call';
  if (content.startsWith('[tool_result]') || displayRole.startsWith('tool result')) return 'result';
  return 'tool';
}

function toolNameFor(message) {
  const metadata = message.metadata || {};
  if (metadata.tool_name) return metadata.tool_name;
  const displayRole = String(message.display_role || '');
  const displayMatch = displayRole.match(/^tool call:\s*(.+)$/i);
  if (displayMatch) return displayMatch[1].trim();
  const callMatch = String(message.content || '').match(/^\[tool_call\]\s*([^\n]+)/);
  if (callMatch) return callMatch[1].trim();
  if (toolKindFor(message) === 'result') return 'tool_result';
  return displayRole || 'tool';
}

function capContent(content, limit) {
  const value = String(content || '').trim();
  if (!Number.isFinite(limit) || limit <= 0 || value.length <= limit) {
    return { content: value, truncated: false, originalChars: value.length };
  }
  return {
    content: `${value.slice(0, limit)}\n\n[truncated; full content available via vault raw_ref metadata]`,
    truncated: true,
    originalChars: value.length
  };
}

function toRecord(message, conversation, options, exportedAtMs) {
  const originalProvider = normalizeProvider(message.provider || conversation?.provider);
  const provider = personalMemoryProvider(originalProvider, options.extendedProviders);
  const isTool = isToolMessage(message);
  const capped = capContent(message.content, options.maxContentChars);
  const sessionId = `${originalProvider || provider}:${message.conversation_id}`;
  const metadata = {
    fromVault: true,
    vaultMessageId: message.id,
    vaultConversationId: message.conversation_id,
    originalProvider,
    originalRole: message.role,
    displayRole: message.display_role || message.role,
    conversationTitle: conversation?.title || '',
    sourceUrl: conversation?.source_url || null,
    sourceFile: conversation?.source_file || message.metadata?.raw_ref?.source_file || null,
    tags: conversation?.tags || [],
    messageIndex: message.index,
    tokenEstimate: message.token_estimate || null,
    rawRef: message.metadata?.raw_ref || null,
    rawRefOnly: Boolean(message.metadata?.raw_ref_only),
    sourceKind: message.metadata?.source_kind || conversation?.metadata?.source_kind || null,
    contentSha256: message.metadata?.content_sha256 || null,
    exportTruncated: capped.truncated,
    originalChars: capped.originalChars
  };

  if (isTool) {
    metadata.tool = {
      name: toolNameFor(message),
      kind: toolKindFor(message),
      id: message.metadata?.tool_id || null
    };
  }

  return {
    id: `vault:${message.id}`,
    role: message.role === 'user' ? 'user' : 'assistant',
    content: capped.content,
    provider,
    sessionId,
    timestamp: timestampMs(message.created_at || conversation?.updated_at, exportedAtMs),
    createdAt: exportedAtMs,
    isPartial: capped.truncated || Boolean(message.metadata?.truncated),
    isDeleted: false,
    isSuperseded: false,
    hasEmbedding: 0,
    metadata
  };
}

function defaultOutputPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(STORE_HOME, 'exports', `personal-ai-memory-${stamp}.json`);
}

function defaultChunkOutputDir() {
  return path.join(STORE_HOME, 'personal-ai-memory-imports');
}

function summarize(records) {
  const byProvider = {};
  let toolRecords = 0;
  for (const record of records) {
    byProvider[record.metadata.originalProvider || record.provider] = (byProvider[record.metadata.originalProvider || record.provider] || 0) + 1;
    if (record.metadata.tool) toolRecords += 1;
  }
  return { records: records.length, tool_records: toolRecords, by_provider: byProvider };
}

function sourceFingerprint() {
  try {
    const stat = fs.statSync(MESSAGES_FILE);
    return `${stat.size}:${Math.floor(stat.mtimeMs)}`;
  } catch {
    return null;
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const conversations = new Map(readJsonl(CONVERSATIONS_FILE).map((row) => [row.id, row]));
  const providerFilter = new Set(options.providers);
  const exportedAt = new Date();
  const exportedAtMs = exportedAt.getTime();
  const records = [];

  for (const message of readJsonl(MESSAGES_FILE)) {
    const conversation = conversations.get(message.conversation_id);
    const originalProvider = normalizeProvider(message.provider || conversation?.provider);
    if (providerFilter.size && !providerFilter.has(originalProvider)) continue;
    if (!options.includeTools && isToolMessage(message)) continue;
    if (!String(message.content || '').trim()) continue;
    records.push(toRecord(message, conversation, options, exportedAtMs));
    if (options.limit && records.length >= options.limit) break;
  }

  const envelope = {
    metadata: {
      app: 'PersonalAIMemoryLayer',
      version: '1.2',
      exportedAt: exportedAt.toISOString(),
      recordCount: records.length,
      embeddingModel: 'ai-chat-vault:no-embedding'
    },
    payload: records,
    prompts: [],
    folders: []
  };

  const summary = {
    store_home: STORE_HOME,
    mode: options.extendedProviders ? 'extended-providers' : 'upstream-compatible-providers',
    includes_tool_calls: options.includeTools,
    source_fingerprint: sourceFingerprint(),
    ...summarize(records)
  };

  if (options.dryRun) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (options.chunkSize) {
    const chunkSize = Math.max(1, Number(options.chunkSize));
    const outDir = path.resolve(options.out || defaultChunkOutputDir());
    fs.mkdirSync(outDir, { recursive: true });

    const files = [];
    for (let offset = 0, chunkIndex = 0; offset < records.length; offset += chunkSize, chunkIndex += 1) {
      const chunk = records.slice(offset, offset + chunkSize);
      const file = path.join(outDir, `personal-ai-memory-${String(chunkIndex + 1).padStart(4, '0')}.json`);
      fs.writeFileSync(file, JSON.stringify({
        ...envelope,
        metadata: {
          ...envelope.metadata,
          recordCount: chunk.length,
          chunkIndex: chunkIndex + 1,
          chunkOffset: offset,
          totalRecordCount: records.length
        },
        payload: chunk
      }));
      files.push(file);
    }

    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
      ...summary,
      generated_at: exportedAt.toISOString(),
      chunk_size: chunkSize,
      chunk_count: files.length,
      files
    }, null, 2));
    console.log(JSON.stringify({ ...summary, output_dir: outDir, chunk_size: chunkSize, chunk_count: files.length }, null, 2));
    return;
  }

  const out = path.resolve(options.out || defaultOutputPath());
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(envelope));
  console.log(JSON.stringify({ ...summary, output: out }, null, 2));
}

main();
