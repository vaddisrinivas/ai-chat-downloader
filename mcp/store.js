import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const STORE_HOME = process.env.AI_CHAT_VAULT_HOME || path.join(os.homedir(), '.ai-chat-vault');
const CONVERSATIONS_FILE = path.join(STORE_HOME, 'conversations.jsonl');
const MESSAGES_FILE = path.join(STORE_HOME, 'messages.jsonl');
const SYNC_STATE_FILE = path.join(STORE_HOME, 'sync-state.json');

const DEFAULT_EXPORT_DIRS = [
  path.join(os.homedir(), 'Downloads', 'AI_Chats')
];

function ensureStore() {
  fs.mkdirSync(STORE_HOME, { recursive: true });
  for (const file of [CONVERSATIONS_FILE, MESSAGES_FILE]) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  }
}

function readJsonl(file) {
  ensureStore();
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line) => JSON.parse(line));
}

function writeJsonl(file, rows) {
  ensureStore();
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(file, body ? `${body}\n` : '');
}

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

function normalizeProvider(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('chatgpt') || text.includes('openai')) return 'chatgpt';
  if (text.includes('claude') || text.includes('anthropic')) return 'claude';
  if (text.includes('gemini')) return 'gemini';
  if (text.includes('perplexity')) return 'perplexity';
  if (text.includes('codex')) return 'codex';
  if (text.includes('grok')) return 'grok';
  if (text.includes('deepseek')) return 'deepseek';
  return 'unknown';
}

function normalizeRole(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('user') || text === 'you') return 'user';
  if (text.includes('system')) return 'system';
  if (text.includes('tool')) return 'tool';
  return 'assistant';
}

function inferProviderFromFilename(filePath) {
  return normalizeProvider(path.basename(filePath));
}

function conversationIdFor(conversation) {
  return shortHash([
    conversation.provider,
    conversation.source_url || '',
    conversation.title || '',
    conversation.created_at || '',
    conversation.source_file || ''
  ].join('|'));
}

function messageIdFor(conversationId, message, index) {
  return shortHash([
    conversationId,
    index,
    message.role || '',
    message.content || ''
  ].join('|'));
}

function upsertConversation(conversation, messages) {
  ensureStore();
  const conversationRows = readJsonl(CONVERSATIONS_FILE);
  const messageRows = readJsonl(MESSAGES_FILE);
  const conversationById = new Map(conversationRows.map((row) => [row.id, row]));
  const messageById = new Map(messageRows.map((row) => [row.id, row]));

  const id = conversation.id || conversationIdFor(conversation);
  const now = new Date().toISOString();
  const normalizedConversation = {
    id,
    provider: normalizeProvider(conversation.provider),
    title: conversation.title || 'Untitled chat',
    source_url: conversation.source_url || null,
    source_file: conversation.source_file || null,
    created_at: safeDate(conversation.created_at) || safeDate(conversation.captured_at) || now,
    updated_at: safeDate(conversation.updated_at) || safeDate(conversation.captured_at) || now,
    imported_at: now,
    tags: conversation.tags || [],
    metadata: conversation.metadata || {}
  };

  conversationById.set(id, {
    ...conversationById.get(id),
    ...normalizedConversation
  });

  messages.forEach((message, index) => {
    const content = String(message.content || '').trim();
    if (!content) return;

    const normalizedMessage = {
      id: message.id || messageIdFor(id, message, index),
      conversation_id: id,
      provider: normalizedConversation.provider,
      role: normalizeRole(message.role || message.display_role),
      display_role: message.display_role || message.role || '',
      content,
      created_at: safeDate(message.created_at) || normalizedConversation.created_at,
      index: Number.isFinite(message.index) ? message.index : index,
      token_estimate: Math.ceil(content.length / 4),
      metadata: message.metadata || {}
    };

    messageById.set(normalizedMessage.id, {
      ...messageById.get(normalizedMessage.id),
      ...normalizedMessage
    });
  });

  writeJsonl(CONVERSATIONS_FILE, [...conversationById.values()].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))));
  writeJsonl(MESSAGES_FILE, [...messageById.values()].sort((a, b) => {
    if (a.conversation_id === b.conversation_id) return a.index - b.index;
    return String(b.created_at).localeCompare(String(a.created_at));
  }));

  return { conversation: normalizedConversation, imported_messages: messages.length };
}

function parseNormalizedJson(raw, sourceFile) {
  const payload = JSON.parse(raw);
  const provider = normalizeProvider(payload.provider || payload.conversation?.provider || inferProviderFromFilename(sourceFile));
  const conversation = {
    ...(payload.conversation || {}),
    provider,
    title: payload.title || payload.conversation?.title || path.basename(sourceFile),
    source_url: payload.source_url || payload.conversation?.source_url || null,
    source_file: sourceFile,
    captured_at: payload.captured_at || payload.conversation?.captured_at || null,
    metadata: {
      source: payload.source || 'json',
      schema_version: payload.schema_version || null
    }
  };

  if (!Array.isArray(payload.messages)) {
    throw new Error(`JSON export has no messages array: ${sourceFile}`);
  }

  return { conversation, messages: payload.messages };
}

function parseMarkdown(raw, sourceFile) {
  const title = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(sourceFile, path.extname(sourceFile));
  const date = raw.match(/^\*\*Date:\*\*\s+(.+)$/m)?.[1]?.trim();
  let provider = inferProviderFromFilename(sourceFile);
  const messages = [];
  const sectionRe = /^###\s+(.+?)(?:\s+\((.*?)\))?\s*\n\n([\s\S]*?)(?=\n---\n\n###\s+|\n---\s*$|$)/gm;
  let match;

  while ((match = sectionRe.exec(raw)) !== null) {
    const displayRole = match[1].trim();
    const time = match[2] || '';
    const content = match[3].trim();
    if (!content) continue;
    messages.push({
      role: normalizeRole(displayRole),
      display_role: displayRole,
      content,
      created_at: safeDate(time) || safeDate(date) || null,
      time,
      metadata: { source_format: 'markdown' }
    });
  }

  if (provider === 'unknown') {
    const assistantMessage = messages.find((message) => message.role === 'assistant');
    provider = normalizeProvider(assistantMessage?.display_role);
  }

  return {
    conversation: {
      provider,
      title,
      source_file: sourceFile,
      captured_at: safeDate(date),
      metadata: { source: 'markdown' }
    },
    messages
  };
}

export function importFile(filePath) {
  const resolved = path.resolve(filePath);
  const raw = fs.readFileSync(resolved, 'utf8');
  const ext = path.extname(resolved).toLowerCase();
  const parsed = ext === '.json'
    ? parseNormalizedJson(raw, resolved)
    : parseMarkdown(raw, resolved);

  if (!parsed.messages.length) {
    return { file: resolved, imported_messages: 0, skipped: true };
  }

  const result = upsertConversation(parsed.conversation, parsed.messages);
  return {
    file: resolved,
    conversation_id: result.conversation.id,
    provider: result.conversation.provider,
    title: result.conversation.title,
    imported_messages: result.imported_messages
  };
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(fullPath));
    else if (entry.isFile() && ['.json', '.md'].includes(path.extname(entry.name).toLowerCase())) out.push(fullPath);
  }
  return out;
}

function readSyncState() {
  try {
    return JSON.parse(fs.readFileSync(SYNC_STATE_FILE, 'utf8'));
  } catch {
    return { files: {} };
  }
}

function writeSyncState(state) {
  ensureStore();
  fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(state, null, 2));
}

export function syncExports(options = {}) {
  const dirs = options.dirs?.length
    ? options.dirs
    : (process.env.AI_CHAT_EXPORT_DIRS ? process.env.AI_CHAT_EXPORT_DIRS.split(path.delimiter) : DEFAULT_EXPORT_DIRS);
  const state = readSyncState();
  const files = dirs.flatMap((dir) => walkFiles(path.resolve(dir)));
  const results = [];

  for (const file of files) {
    const stat = fs.statSync(file);
    const key = path.resolve(file);
    const fingerprint = `${stat.size}:${stat.mtimeMs}`;
    if (!options.force && state.files[key] === fingerprint) continue;

    try {
      const result = importFile(file);
      results.push(result);
      state.files[key] = fingerprint;
    } catch (error) {
      results.push({ file, error: error.message });
    }
  }

  state.last_sync_at = new Date().toISOString();
  state.dirs = dirs;
  writeSyncState(state);
  return {
    store_home: STORE_HOME,
    scanned_files: files.length,
    changed_files: results.length,
    results
  };
}

export function listConversations(options = {}) {
  const provider = options.provider ? normalizeProvider(options.provider) : null;
  const limit = Math.max(1, Number(options.limit || 50));
  return readJsonl(CONVERSATIONS_FILE)
    .filter((row) => !provider || row.provider === provider)
    .slice(0, limit);
}

export function getConversation(id) {
  const conversations = readJsonl(CONVERSATIONS_FILE);
  const conversation = conversations.find((row) => row.id === id);
  if (!conversation) return null;
  const messages = readJsonl(MESSAGES_FILE).filter((row) => row.conversation_id === id);
  return { conversation, messages };
}

export function searchChats(options = {}) {
  const query = String(options.query || '').trim().toLowerCase();
  if (!query) return [];

  const terms = query.split(/\s+/).filter(Boolean);
  const provider = options.provider ? normalizeProvider(options.provider) : null;
  const limit = Math.max(1, Number(options.limit || 20));
  const conversations = new Map(readJsonl(CONVERSATIONS_FILE).map((row) => [row.id, row]));

  return readJsonl(MESSAGES_FILE)
    .filter((message) => !provider || message.provider === provider)
    .map((message) => {
      const haystack = `${message.content} ${conversations.get(message.conversation_id)?.title || ''}`.toLowerCase();
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return { message, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || String(b.message.created_at).localeCompare(String(a.message.created_at)))
    .slice(0, limit)
    .map(({ message, score }) => ({
      score,
      conversation: conversations.get(message.conversation_id),
      message: {
        ...message,
        content_preview: message.content.slice(0, 700)
      }
    }));
}

export function buildContextPack(options = {}) {
  const maxChars = Math.max(1000, Number(options.max_chars || 8000));
  const results = searchChats({ ...options, limit: options.limit || 50 });
  const lines = [
    `# AI Chat Context Pack`,
    ``,
    `Query: ${options.query || ''}`,
    `Generated: ${new Date().toISOString()}`,
    `Store: ${STORE_HOME}`,
    ``
  ];

  for (const result of results) {
    const conversation = result.conversation || {};
    const message = result.message;
    const block = [
      `## ${conversation.title || 'Untitled'} (${conversation.provider || message.provider})`,
      `Conversation: ${message.conversation_id}`,
      conversation.source_url ? `Source: ${conversation.source_url}` : null,
      `Role: ${message.display_role || message.role}`,
      ``,
      message.content
    ].filter(Boolean).join('\n');

    if ((lines.join('\n').length + block.length) > maxChars) break;
    lines.push(block, '');
  }

  return lines.join('\n').slice(0, maxChars);
}

export function dailyCheck() {
  ensureStore();
  const conversations = readJsonl(CONVERSATIONS_FILE);
  const messages = readJsonl(MESSAGES_FILE);
  const byProvider = {};
  for (const conversation of conversations) {
    byProvider[conversation.provider] = (byProvider[conversation.provider] || 0) + 1;
  }
  const state = readSyncState();

  return {
    store_home: STORE_HOME,
    conversations: conversations.length,
    messages: messages.length,
    by_provider: byProvider,
    last_sync_at: state.last_sync_at || null,
    newest_conversations: conversations.slice(0, 10).map((row) => ({
      id: row.id,
      provider: row.provider,
      title: row.title,
      updated_at: row.updated_at
    }))
  };
}
