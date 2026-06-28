import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { STORE_HOME, upsertConversationBatch } from './store.js';

const LOCAL_SYNC_STATE_FILE = path.join(STORE_HOME, 'local-sync-state.json');
const DEFAULT_MESSAGE_LIMIT = Number(process.env.AI_CHAT_VAULT_MESSAGE_CHARS || 12000);
const DEFAULT_TOOL_RESULT_LIMIT = Number(process.env.AI_CHAT_VAULT_TOOL_RESULT_CHARS || 1200);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function shortHash(value) {
  return sha256(value).slice(0, 16);
}

function safeDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function statFingerprint(filePath) {
  const stat = fs.statSync(filePath);
  return `${stat.size}:${stat.mtimeMs}`;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function readLocalState() {
  return readJson(LOCAL_SYNC_STATE_FILE, { files: {} });
}

function writeLocalState(state) {
  state.last_sync_at = new Date().toISOString();
  writeJson(LOCAL_SYNC_STATE_FILE, state);
}

function* walkFiles(root, predicate, maxDepth = 12, depth = 0) {
  if (depth > maxDepth || !fs.existsSync(root)) return;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      yield* walkFiles(fullPath, predicate, maxDepth, depth + 1);
    } else if (entry.isFile() && predicate(fullPath)) {
      yield fullPath;
    }
  }
}

function capText(text, limit = DEFAULT_MESSAGE_LIMIT) {
  const value = String(text || '').trim();
  if (value.length <= limit) return { content: value, truncated: false, original_chars: value.length };
  return {
    content: `${value.slice(0, limit)}\n\n[truncated; full content available via raw_ref]`,
    truncated: true,
    original_chars: value.length
  };
}

function sourceRef(filePath, line = null, extra = {}) {
  return {
    source_file: filePath,
    line,
    ...extra
  };
}

function messageId(provider, filePath, index, line = null, extra = '') {
  return `${provider}-${shortHash([filePath, index, line || '', extra].join('|'))}`;
}

function firstNonEmpty(items) {
  return items.find((item) => String(item || '').trim()) || '';
}

function extractText(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => extractText(item, depth + 1)).filter(Boolean).join('\n');
  if (typeof value !== 'object') return '';

  if (typeof value.text === 'string') return value.text;
  if (typeof value.value === 'string') return value.value;
  if (typeof value.content === 'string') return value.content;

  const keys = ['message', 'content', 'parts', 'response', 'markdown', 'body', 'text', 'value'];
  return keys.map((key) => extractText(value[key], depth + 1)).filter(Boolean).join('\n');
}

function formatJsonCompact(value, limit = 3000) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value || {});
  return capText(raw, limit).content;
}

function sourceTitleFromFile(filePath) {
  return path.basename(filePath).replace(/\.(jsonl?|md)$/i, '');
}

async function parseJsonl(filePath, onObject) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });

  let lineNo = 0;
  for await (const line of rl) {
    lineNo += 1;
    if (!line.trim()) continue;
    try {
      await onObject(JSON.parse(line), lineNo);
    } catch {
      // Ignore malformed lines; source scanners report file-level errors elsewhere.
    }
  }
}

function makeConversation({ id, provider, title, filePath, createdAt, updatedAt, metadata }) {
  return {
    id,
    provider,
    title,
    source_file: filePath,
    created_at: createdAt,
    updated_at: updatedAt || createdAt,
    tags: ['local-history'],
    metadata: {
      raw_ref_mode: 'source-file-reference',
      ...metadata
    }
  };
}

function addMessage(messages, {
  provider,
  filePath,
  line,
  index,
  role,
  displayRole,
  content,
  createdAt,
  limit,
  metadata = {}
}) {
  const capped = capText(content, limit);
  if (!capped.content) return;
  messages.push({
    id: messageId(provider, filePath, index, line, metadata.tool_id || metadata.request_id || ''),
    provider,
    role,
    display_role: displayRole || role,
    content: capped.content,
    created_at: createdAt,
    index,
    metadata: {
      ...metadata,
      raw_ref: sourceRef(filePath, line, metadata.raw_ref || {}),
      content_sha256: sha256(String(content || '')),
      truncated: capped.truncated,
      original_chars: capped.original_chars
    }
  });
}

function addReferenceMessage(messages, {
  provider,
  filePath,
  line,
  index,
  role = 'tool',
  displayRole,
  createdAt,
  referenceLabel,
  metadata = {}
}) {
  const content = `${referenceLabel}\n[raw_ref_only] Open source_file/line in metadata for full content.`;
  messages.push({
    id: messageId(provider, filePath, index, line, metadata.tool_id || metadata.request_id || referenceLabel),
    provider,
    role,
    display_role: displayRole || role,
    content,
    created_at: createdAt,
    index,
    metadata: {
      ...metadata,
      raw_ref: sourceRef(filePath, line, metadata.raw_ref || {}),
      raw_ref_only: true
    }
  });
}

async function importCodexSession(filePath) {
  const messages = [];
  let meta = {};
  let firstDate = null;
  let lastDate = null;
  let seq = 0;
  let firstUserText = '';

  await parseJsonl(filePath, (row, line) => {
    const timestamp = safeDate(row.timestamp) || safeDate(row.payload?.timestamp);
    if (timestamp) {
      firstDate ||= timestamp;
      lastDate = timestamp;
    }

    if (row.type === 'session_meta') {
      meta = { ...meta, ...(row.payload || {}) };
      return;
    }

    if (row.type !== 'response_item') return;
    const item = row.payload || {};
    const common = {
      provider: 'codex',
      filePath,
      line,
      createdAt: timestamp,
      index: seq
    };

    if (item.role && item.content) {
      const text = extractText(item.content);
      if (item.role === 'user') firstUserText ||= text;
      addMessage(messages, {
        ...common,
        index: seq++,
        role: item.role === 'user' ? 'user' : 'assistant',
        displayRole: `codex ${item.role}`,
        content: text,
        metadata: { codex_item_type: item.type || 'message', cwd: meta.cwd || null }
      });
      return;
    }

    if (item.type === 'function_call') {
      addMessage(messages, {
        ...common,
        index: seq++,
        role: 'tool',
        displayRole: `tool call: ${item.name}`,
        content: `[tool_call] ${item.name}\n${formatJsonCompact(item.arguments, 4000)}`,
        limit: DEFAULT_TOOL_RESULT_LIMIT,
        metadata: {
          codex_item_type: item.type,
          tool_name: item.name,
          tool_id: item.call_id,
          raw_ref: { call_id: item.call_id }
        }
      });
      return;
    }

    if (item.type === 'function_call_output') {
      addReferenceMessage(messages, {
        ...common,
        index: seq++,
        displayRole: `tool result: ${item.call_id}`,
        referenceLabel: `[tool_result] ${item.call_id}`,
        metadata: {
          codex_item_type: item.type,
          tool_id: item.call_id,
          raw_ref: { call_id: item.call_id }
        }
      });
    }
  });

  const sessionId = meta.session_id || meta.id || shortHash(filePath);
  const title = firstNonEmpty([
    firstUserText.slice(0, 90),
    meta.cwd ? `Codex: ${meta.cwd}` : '',
    sourceTitleFromFile(filePath)
  ]);

  return {
    conversation: makeConversation({
      id: `codex:${sessionId}`,
      provider: 'codex',
      title,
      filePath,
      createdAt: safeDate(meta.timestamp) || firstDate,
      updatedAt: lastDate || safeDate(meta.timestamp),
      metadata: {
        source_kind: 'codex-session',
        session_id: sessionId,
        cwd: meta.cwd || null,
        originator: meta.originator || null,
        cli_version: meta.cli_version || null,
        source: meta.source || null
      }
    }),
    messages
  };
}

function extractClaudeContent(entry) {
  const content = entry.message?.content;
  if (typeof content === 'string') {
    return [{ kind: 'text', role: entry.message?.role || entry.type, text: content }];
  }
  if (!Array.isArray(content)) return [];

  return content.flatMap((part) => {
    if (!part || typeof part !== 'object') return [];
    if (part.type === 'text') return [{ kind: 'text', role: entry.message?.role || entry.type, text: part.text || '' }];
    if (part.type === 'tool_use') {
      return [{
        kind: 'tool_call',
        role: 'tool',
        text: `[tool_call] ${part.name}\n${formatJsonCompact(part.input, 4000)}`,
        tool_name: part.name,
        tool_id: part.id
      }];
    }
    if (part.type === 'tool_result') {
      return [{
        kind: 'tool_result',
        role: 'tool',
        text: `[tool_result] ${part.tool_use_id || ''}`,
        tool_id: part.tool_use_id
      }];
    }
    return [];
  });
}

async function importClaudeSession(filePath) {
  const messages = [];
  let sessionId = null;
  let cwd = null;
  let firstDate = null;
  let lastDate = null;
  let firstUserText = '';
  let seq = 0;

  await parseJsonl(filePath, (entry, line) => {
    const timestamp = safeDate(entry.timestamp);
    if (timestamp) {
      firstDate ||= timestamp;
      lastDate = timestamp;
    }
    sessionId ||= entry.sessionId;
    cwd ||= entry.cwd;

    for (const part of extractClaudeContent(entry)) {
      if (part.role === 'user') firstUserText ||= part.text;
      if (part.kind === 'tool_result') {
        addReferenceMessage(messages, {
          provider: 'claude',
          filePath,
          line,
          index: seq++,
          displayRole: 'tool result',
          referenceLabel: part.text,
          createdAt: timestamp,
          metadata: {
            claude_type: entry.type,
            content_kind: part.kind,
            tool_id: part.tool_id || null,
            cwd: entry.cwd || cwd || null,
            raw_ref: { uuid: entry.uuid || null, parent_uuid: entry.parentUuid || null }
          }
        });
        continue;
      }
      addMessage(messages, {
        provider: 'claude',
        filePath,
        line,
        index: seq++,
        role: part.role === 'user' ? 'user' : part.role === 'tool' ? 'tool' : 'assistant',
        displayRole: part.kind === 'text' ? `claude ${part.role}` : part.kind.replace('_', ' '),
        content: part.text,
        createdAt: timestamp,
        limit: part.kind === 'tool_result' ? DEFAULT_TOOL_RESULT_LIMIT : DEFAULT_MESSAGE_LIMIT,
        metadata: {
          claude_type: entry.type,
          content_kind: part.kind,
          tool_name: part.tool_name || null,
          tool_id: part.tool_id || null,
          cwd: entry.cwd || cwd || null,
          model: entry.message?.model || null,
          raw_ref: { uuid: entry.uuid || null, parent_uuid: entry.parentUuid || null }
        }
      });
    }
  });

  const id = sessionId || shortHash(filePath);
  return {
    conversation: makeConversation({
      id: `claude:${id}`,
      provider: 'claude',
      title: firstNonEmpty([firstUserText.slice(0, 90), cwd ? `Claude: ${cwd}` : '', sourceTitleFromFile(filePath)]),
      filePath,
      createdAt: firstDate,
      updatedAt: lastDate,
      metadata: {
        source_kind: 'claude-code-session',
        session_id: id,
        cwd
      }
    }),
    messages
  };
}

function importGeminiChat(filePath) {
  const payload = readJson(filePath, null);
  if (!payload || !Array.isArray(payload.messages)) return null;

  const messages = [];
  const sessionId = payload.sessionId || shortHash(filePath);
  payload.messages.forEach((message, index) => {
    const text = extractText(message.content);
    addMessage(messages, {
      provider: 'gemini',
      filePath,
      line: null,
      index,
      role: message.type === 'user' ? 'user' : 'assistant',
      displayRole: message.type === 'user' ? 'gemini user' : 'gemini',
      content: text,
      createdAt: safeDate(message.timestamp),
      metadata: {
        source_kind: 'gemini-cli-chat',
        message_id: message.id || null,
        model: message.model || null,
        thoughts_count: Array.isArray(message.thoughts) ? message.thoughts.length : 0
      }
    });
  });

  return {
    conversation: makeConversation({
      id: `gemini:${sessionId}`,
      provider: 'gemini',
      title: firstNonEmpty([messages.find((m) => m.role === 'user')?.content?.slice(0, 90), sourceTitleFromFile(filePath)]),
      filePath,
      createdAt: safeDate(payload.startTime),
      updatedAt: safeDate(payload.lastUpdated),
      metadata: {
        source_kind: 'gemini-cli-chat',
        session_id: sessionId,
        project_hash: payload.projectHash || null
      }
    }),
    messages
  };
}

function importAntigravityBrain(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) return null;
  const folder = path.basename(path.dirname(filePath));
  const title = `${path.basename(filePath, '.md')} (${folder})`;
  const stat = fs.statSync(filePath);
  const capped = capText(raw, DEFAULT_MESSAGE_LIMIT);

  return {
    conversation: makeConversation({
      id: `gemini-antigravity:${folder}:${shortHash(path.dirname(filePath))}`,
      provider: 'gemini',
      title: `Antigravity task ${folder}`,
      filePath: path.dirname(filePath),
      createdAt: stat.birthtime.toISOString(),
      updatedAt: stat.mtime.toISOString(),
      metadata: {
        source_kind: 'gemini-antigravity-brain',
        antigravity_id: folder
      }
    }),
    messages: [{
      id: messageId('gemini-antigravity', filePath, 0),
      role: 'assistant',
      display_role: 'antigravity artifact',
      content: `# ${title}\n\n${capped.content}`,
      created_at: stat.mtime.toISOString(),
      index: Number(stat.mtimeMs),
      metadata: {
        raw_ref: sourceRef(filePath),
        content_sha256: sha256(raw),
        truncated: capped.truncated,
        original_chars: capped.original_chars,
        source_kind: 'gemini-antigravity-brain'
      }
    }]
  };
}

function importVsCodeChatFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return null;
  const rows = filePath.endsWith('.jsonl')
    ? raw.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [JSON.parse(raw)];
  const messages = [];
  let conversationPayload = null;
  let seq = 0;

  rows.forEach((row, rowIndex) => {
    const payload = row.v || row;
    if (!payload || !Array.isArray(payload.requests)) return;
    conversationPayload ||= payload;
    payload.requests.forEach((request, requestIndex) => {
      const timestamp = safeDate(request.timestamp);
      const agentId = extractText(request.agent?.extensionId?.value || request.agent?.id || '');
      const provider = String(agentId).toLowerCase().includes('copilot') || filePath.toLowerCase().includes('copilot')
        ? 'github-copilot'
        : 'vscode-chat';
      const userText = extractText(request.message?.text || request.message?.parts || request.message);
      addMessage(messages, {
        provider,
        filePath,
        line: filePath.endsWith('.jsonl') ? rowIndex + 1 : null,
        index: seq++,
        role: 'user',
        displayRole: `${provider} user`,
        content: userText,
        createdAt: timestamp,
        metadata: {
          source_kind: 'vscode-chat-session',
          request_id: request.requestId || null,
          model_id: request.modelId || null,
          agent_id: agentId || null,
          raw_ref: { request_index: requestIndex }
        }
      });

      const responseText = extractText(request.response || request.result?.response || request.responseMarkdownInfo);
      addMessage(messages, {
        provider,
        filePath,
        line: filePath.endsWith('.jsonl') ? rowIndex + 1 : null,
        index: seq++,
        role: 'assistant',
        displayRole: provider,
        content: responseText,
        createdAt: timestamp,
        metadata: {
          source_kind: 'vscode-chat-session',
          request_id: request.requestId || null,
          model_id: request.modelId || null,
          agent_id: agentId || null,
          raw_ref: { request_index: requestIndex }
        }
      });
    });
  });

  if (!conversationPayload || !messages.length) return null;
  const firstProvider = messages.find((message) => message.provider === 'github-copilot') ? 'github-copilot' : 'vscode-chat';
  const sessionId = conversationPayload.sessionId || shortHash(filePath);
  return {
    conversation: makeConversation({
      id: `${firstProvider}:${sessionId}`,
      provider: firstProvider,
      title: conversationPayload.customTitle || firstNonEmpty([messages.find((m) => m.role === 'user')?.content?.slice(0, 90), sourceTitleFromFile(filePath)]),
      filePath,
      createdAt: safeDate(conversationPayload.creationDate),
      updatedAt: safeDate(conversationPayload.lastMessageDate) || safeDate(fs.statSync(filePath).mtime),
      metadata: {
        source_kind: 'vscode-chat-session',
        session_id: sessionId
      }
    }),
    messages
  };
}

function discoverLocalSourceFiles() {
  const home = os.homedir();
  const sources = [];

  const add = (source, filePath) => sources.push({ source, filePath });

  for (const filePath of walkFiles(path.join(home, '.codex', 'sessions'), (file) => file.endsWith('.jsonl'), 8)) {
    add('codex', filePath);
  }
  for (const filePath of walkFiles(path.join(home, '.claude', 'projects'), (file) => file.endsWith('.jsonl'), 8)) {
    add('claude', filePath);
  }
  for (const filePath of walkFiles(path.join(home, '.gemini', 'tmp'), (file) => /\/chats\/.+\.json$/.test(file), 8)) {
    add('gemini', filePath);
  }
  for (const filePath of walkFiles(path.join(home, '.gemini', 'antigravity', 'brain'), (file) => file.endsWith('.md') && !file.includes('/.tempmediaStorage/'), 3)) {
    add('gemini-antigravity', filePath);
  }

  const codeStorage = path.join(home, 'Library', 'Application Support', 'Code', 'User');
  for (const filePath of walkFiles(path.join(codeStorage, 'globalStorage', 'emptyWindowChatSessions'), (file) => /\.(json|jsonl)$/.test(file), 2)) {
    add('vscode-chat', filePath);
  }
  for (const filePath of walkFiles(path.join(codeStorage, 'workspaceStorage'), (file) => /\/chatSessions\/.+\.(json|jsonl)$/.test(file), 3)) {
    add('vscode-chat', filePath);
  }
  for (const filePath of walkFiles(path.join(codeStorage, 'globalStorage', 'github.copilot-chat'), (file) => /Sessions\.jsonl?$/.test(file), 2)) {
    add('github-copilot', filePath);
  }

  const extraDirs = process.env.AI_CHAT_LOCAL_DIRS
    ? process.env.AI_CHAT_LOCAL_DIRS.split(path.delimiter).filter(Boolean)
    : [];
  for (const dir of extraDirs) {
    for (const filePath of walkFiles(path.resolve(dir), (file) => /\.(json|jsonl|md)$/.test(file), 8)) {
      add('extra', filePath);
    }
  }

  return sources;
}

async function importSourceFile(source, filePath) {
  if (source === 'codex') return importCodexSession(filePath);
  if (source === 'claude') return importClaudeSession(filePath);
  if (source === 'gemini') return importGeminiChat(filePath);
  if (source === 'gemini-antigravity') return importAntigravityBrain(filePath);
  if (source === 'vscode-chat' || source === 'github-copilot') return importVsCodeChatFile(filePath);
  if (filePath.endsWith('.md')) return importAntigravityBrain(filePath);
  if (filePath.endsWith('.json') || filePath.endsWith('.jsonl')) return importVsCodeChatFile(filePath);
  return null;
}

export async function syncLocalSources(options = {}) {
  const state = readLocalState();
  const sources = discoverLocalSourceFiles();
  const changed = [];
  const errors = [];
  const items = [];
  const bySource = {};

  for (const sourceInfo of sources) {
    const { source, filePath } = sourceInfo;
    let fingerprint;
    try {
      fingerprint = statFingerprint(filePath);
    } catch {
      continue;
    }
    const key = `${source}:${filePath}`;
    bySource[source] ||= { scanned_files: 0, changed_files: 0, conversations: 0, messages: 0, errors: 0 };
    bySource[source].scanned_files += 1;
    if (!options.force && state.files[key] === fingerprint) continue;

    try {
      const item = await importSourceFile(source, filePath);
      state.files[key] = fingerprint;
      changed.push(filePath);
      bySource[source].changed_files += 1;
      if (item && item.messages?.length) {
        items.push(item);
        bySource[source].conversations += 1;
        bySource[source].messages += item.messages.length;
      }
    } catch (error) {
      errors.push({ source, file: filePath, error: error.message });
      bySource[source].errors += 1;
    }
  }

  const persisted = upsertConversationBatch(items);
  writeLocalState(state);

  return {
    store_home: STORE_HOME,
    mode: 'local-source-references',
    scanned_files: sources.length,
    changed_files: changed.length,
    imported_conversations: persisted.length,
    imported_messages: persisted.reduce((total, row) => total + row.imported_messages, 0),
    by_source: bySource,
    errors: errors.slice(0, 50)
  };
}

export function readRawRef(options = {}) {
  const sourceFile = options.source_file || options.sourceFile || options.file;
  if (!sourceFile) throw new Error('source_file is required');
  const resolved = path.resolve(sourceFile);
  const maxChars = Math.max(200, Number(options.max_chars || options.maxChars || 8000));
  const line = Number(options.line || 0);

  if (!fs.existsSync(resolved)) throw new Error(`Raw source not found: ${resolved}`);

  if (!line || line < 1) {
    const raw = fs.readFileSync(resolved, 'utf8');
    const capped = capText(raw, maxChars);
    return {
      source_file: resolved,
      line: null,
      content: capped.content,
      truncated: capped.truncated,
      original_chars: capped.original_chars
    };
  }

  const radius = Math.max(0, Number(options.radius || 0));
  const start = Math.max(1, line - radius);
  const end = line + radius;
  const out = [];
  const rawLines = fs.readFileSync(resolved, 'utf8').split('\n');
  for (let index = start; index <= Math.min(end, rawLines.length); index += 1) {
    out.push(`${index}: ${rawLines[index - 1]}`);
  }
  const content = out.join('\n');
  const capped = capText(content, maxChars);
  return {
    source_file: resolved,
    line,
    start_line: start,
    end_line: Math.min(end, rawLines.length),
    content: capped.content,
    truncated: capped.truncated,
    original_chars: capped.original_chars
  };
}
