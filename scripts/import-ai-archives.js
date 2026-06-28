#!/usr/bin/env node
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_SCAN_DIR = path.join(os.homedir(), 'Downloads');
const DEFAULT_OUT_ROOT = path.join(os.homedir(), 'Downloads', 'AI_Chats');
const ARCHIVE_EXTRACT_DIR = path.join(DEFAULT_OUT_ROOT, '_archives');
const SCHEMA_VERSION = 'ai-chat-vault.normalized.v1';

function parseArgs(argv) {
  const options = {
    sources: [],
    outRoot: DEFAULT_OUT_ROOT,
    force: false,
    sync: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source') options.sources.push(argv[++index]);
    else if (arg === '--out') options.outRoot = argv[++index];
    else if (arg === '--force') options.force = true;
    else if (arg === '--sync') options.sync = true;
    else if (arg === '--help') {
      console.log(`Usage: node scripts/import-ai-archives.js [--source <zip-or-dir>] [--out <dir>] [--force] [--sync]`);
      process.exit(0);
    }
  }

  if (!options.sources.length) options.sources.push(DEFAULT_SCAN_DIR);
  return options;
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

function cleanText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function stripHtml(value) {
  return cleanText(String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"'));
}

function firstLine(value, fallback = 'Untitled chat') {
  const line = cleanText(value).split('\n').find(Boolean) || fallback;
  return line.length > 140 ? `${line.slice(0, 139)}...` : line;
}

function safeName(value) {
  return String(value || 'archive')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'archive';
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function* walk(root, predicate, maxDepth = 12, depth = 0) {
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
      yield* walk(fullPath, predicate, maxDepth, depth + 1);
    } else if (entry.isFile() && predicate(fullPath)) {
      yield fullPath;
    }
  }
}

function discoverInputs(sources) {
  const inputs = [];
  for (const source of sources.map((item) => path.resolve(item))) {
    if (!fs.existsSync(source)) continue;
    const stat = fs.statSync(source);
    if (stat.isDirectory()) {
      inputs.push({ type: 'dir', path: source });
      for (const filePath of walk(source, (file) => /\.zip$/i.test(file), 3)) {
        const name = path.basename(filePath).toLowerCase();
        if (/(takeout|google|gemini|claude|anthropic)/.test(name) || /^data-.*-batch-\d+\.zip$/i.test(name)) {
          inputs.push({ type: 'zip', path: filePath });
        }
      }
    } else if (/\.zip$/i.test(source)) {
      inputs.push({ type: 'zip', path: source });
    }
  }
  return inputs;
}

function extractZip(zipPath, force) {
  const stat = fs.statSync(zipPath);
  const extractRoot = path.join(ARCHIVE_EXTRACT_DIR, `${safeName(path.basename(zipPath, '.zip'))}-${shortHash(`${zipPath}:${stat.size}`)}`);
  const marker = path.join(extractRoot, '.ai-chat-vault-extracted');
  if ((force || (fs.existsSync(extractRoot) && !fs.existsSync(marker))) && fs.existsSync(extractRoot)) {
    fs.rmSync(extractRoot, { recursive: true, force: true });
  }
  if (!fs.existsSync(marker)) {
    fs.mkdirSync(extractRoot, { recursive: true });
    try {
      childProcess.execFileSync('unzip', ['-q', zipPath, '-d', extractRoot], { stdio: 'ignore' });
    } catch {
      fs.rmSync(extractRoot, { recursive: true, force: true });
      fs.mkdirSync(extractRoot, { recursive: true });
      childProcess.execFileSync('ditto', ['-x', '-k', zipPath, extractRoot], { stdio: 'ignore' });
    }
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
  }
  return extractRoot;
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
  if (typeof value.markdown === 'string') return value.markdown;
  return ['message', 'content', 'parts', 'response', 'body', 'text', 'value']
    .map((key) => extractText(value[key], depth + 1))
    .filter(Boolean)
    .join('\n');
}

function claudeMessageContent(message) {
  const direct = cleanText(message.text || message.content_text || message.content);
  if (direct) return direct;
  const content = message.content || message.parts || [];
  if (!Array.isArray(content)) return extractText(content);
  return content.map((part) => {
    if (part?.type === 'text') return part.text || '';
    if (part?.type === 'tool_use') return `[tool_call] ${part.name || ''}\n${JSON.stringify(part.input || {}, null, 2)}`;
    if (part?.type === 'tool_result') return `[tool_result] ${part.tool_use_id || ''}\n${extractText(part.content)}`;
    return extractText(part);
  }).filter(Boolean).join('\n\n');
}

function normalizeClaudeConversation(conversation, sourceFile, rawArchive) {
  const rawMessages = conversation.chat_messages || conversation.messages || conversation.items || [];
  const messages = [];
  rawMessages.forEach((message, index) => {
    const content = claudeMessageContent(message);
    if (!cleanText(content)) return;
    const sender = String(message.sender || message.role || message.author || '').toLowerCase();
    messages.push({
      id: `claude-web:${message.uuid || message.id || shortHash(`${sourceFile}:${index}:${content}`)}`,
      role: sender.includes('human') || sender.includes('user') ? 'user' : sender.includes('tool') ? 'tool' : 'assistant',
      display_role: sender || 'claude',
      content,
      created_at: safeDate(message.created_at || message.createdAt || conversation.created_at),
      index,
      metadata: {
        source: 'claude-web-export',
        raw_archive: rawArchive,
        source_file: sourceFile,
        message_uuid: message.uuid || message.id || null,
        parent_message_uuid: message.parent_message_uuid || message.parentUuid || null,
        model: message.model || null,
        attachments: Array.isArray(message.attachments) ? message.attachments.length : 0
      }
    });
  });

  if (!messages.length) return null;
  const title = firstLine(conversation.name || conversation.title || messages.find((m) => m.role === 'user')?.content, 'Claude web chat');
  const uuid = conversation.uuid || conversation.id || shortHash(`${sourceFile}:${title}`);
  return {
    provider: 'claude',
    title,
    source: 'claude-web-export',
    source_url: uuid ? `https://claude.ai/chat/${uuid}` : null,
    captured_at: new Date().toISOString(),
    schema_version: SCHEMA_VERSION,
    conversation: {
      id: `claude-web:${uuid}`,
      provider: 'claude',
      title,
      source_url: uuid ? `https://claude.ai/chat/${uuid}` : null,
      captured_at: new Date().toISOString(),
      created_at: safeDate(conversation.created_at || conversation.createdAt || messages[0]?.created_at),
      updated_at: safeDate(conversation.updated_at || conversation.updatedAt || messages.at(-1)?.created_at),
      metadata: {
        source: 'claude-web-export',
        raw_archive: rawArchive,
        source_file: sourceFile,
        conversation_uuid: uuid,
        project_uuid: conversation.project_uuid || null
      }
    },
    messages
  };
}

function processClaudeExports(root, rawArchive, outRoot) {
  const outDir = path.join(outRoot, 'claude-web');
  const written = [];
  for (const filePath of walk(root, (file) => /\.json$/i.test(file) && /conversation|chat/i.test(path.basename(file)), 10)) {
    let payload;
    try {
      payload = readJson(filePath);
    } catch {
      continue;
    }
    const candidates = Array.isArray(payload)
      ? payload
      : Array.isArray(payload.conversations)
        ? payload.conversations
        : [payload.conversation || payload];

    for (const conversation of candidates) {
      if (!conversation || typeof conversation !== 'object') continue;
      if (!Array.isArray(conversation.chat_messages) && !Array.isArray(conversation.messages) && !Array.isArray(conversation.items)) continue;
      const normalized = normalizeClaudeConversation(conversation, filePath, rawArchive);
      if (!normalized) continue;
      const name = safeName(normalized.conversation.id || normalized.title);
      const outFile = path.join(outDir, `${name}.json`);
      writeJson(outFile, normalized);
      written.push(outFile);
    }
  }
  return written;
}

function geminiRecordText(record) {
  const parts = [];
  for (const key of ['title', 'description', 'details']) {
    const text = extractText(record[key]);
    if (text) parts.push(text);
  }
  if (Array.isArray(record.subtitles)) parts.push(extractText(record.subtitles));
  return cleanText(parts.join('\n'));
}

function isGeminiActivity(record, sourceFile) {
  const haystack = `${sourceFile} ${record.header || ''} ${record.title || ''} ${record.titleUrl || ''} ${extractText(record.products)}`.toLowerCase();
  return haystack.includes('gemini') || haystack.includes('bard');
}

function normalizeGeminiActivities(records, sourceFile, rawArchive) {
  const grouped = new Map();
  for (const record of records) {
    if (!record || typeof record !== 'object' || !isGeminiActivity(record, sourceFile)) continue;
    const content = geminiRecordText(record);
    if (!content) continue;
    const key = record.titleUrl || `${(record.time || '').slice(0, 10)}:${firstLine(content)}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(record);
  }

  const conversations = [];
  for (const [key, items] of grouped) {
    const ordered = items.sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
    const firstText = geminiRecordText(ordered[0]);
    const id = `gemini-web:${shortHash(key)}`;
    const messages = ordered.map((record, index) => ({
      id: `${id}:${shortHash(`${record.time || ''}:${geminiRecordText(record)}`)}`,
      role: 'user',
      display_role: 'gemini web activity',
      content: geminiRecordText(record),
      created_at: safeDate(record.time),
      index,
      metadata: {
        source: 'google-takeout-my-activity-gemini-apps',
        raw_archive: rawArchive,
        source_file: sourceFile,
        title_url: record.titleUrl || null,
        products: record.products || null
      }
    }));

    conversations.push({
      provider: 'gemini',
      title: firstLine(firstText, 'Gemini web activity'),
      source: 'google-takeout-my-activity-gemini-apps',
      source_url: ordered[0].titleUrl || null,
      captured_at: new Date().toISOString(),
      schema_version: SCHEMA_VERSION,
      conversation: {
        id,
        provider: 'gemini',
        title: firstLine(firstText, 'Gemini web activity'),
        source_url: ordered[0].titleUrl || null,
        captured_at: new Date().toISOString(),
        created_at: safeDate(ordered[0].time),
        updated_at: safeDate(ordered.at(-1).time),
        metadata: {
          source: 'google-takeout-my-activity-gemini-apps',
          raw_archive: rawArchive,
          source_file: sourceFile,
          takeout_group_key: key
        }
      },
      messages
    });
  }
  return conversations;
}

function parseGeminiHtmlActivities(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const cells = raw.split(/<div[^>]*class="[^"]*\bouter-cell\b[^"]*"[^>]*>/i).slice(1);
  return cells.map((cell) => {
    const contentHtml = cell.match(/<div[^>]*class="[^"]*\bcontent-cell\b(?=[^"]*\bmdl-typography--body-1\b)(?![^"]*\bmdl-typography--text-right\b)[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || cell;
    const title = stripHtml(contentHtml);
    const time = title.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4},\s+[^\\n]+?\s+(?:AM|PM)\s+[A-Z]{2,4}\b/)?.[0] || null;
    return {
      title,
    titleUrl: cell.match(/href="([^"]+)"/i)?.[1] || null,
      time,
    products: ['Gemini Apps']
    };
  });
}

function processGeminiTakeout(root, rawArchive, outRoot) {
  const outDir = path.join(outRoot, 'gemini-web');
  const written = [];
  const files = [...walk(root, (file) => {
    const lower = file.toLowerCase();
    return lower.includes('my activity') && (lower.includes('gemini') || lower.includes('bard')) && /\.(json|html?)$/i.test(file);
  }, 12)];

  for (const filePath of files) {
    let records = [];
    try {
      records = /\.json$/i.test(filePath) ? readJson(filePath) : parseGeminiHtmlActivities(filePath);
    } catch {
      continue;
    }
    if (!Array.isArray(records)) continue;
    for (const normalized of normalizeGeminiActivities(records, filePath, rawArchive)) {
      const outFile = path.join(outDir, `${safeName(normalized.conversation.id)}.json`);
      writeJson(outFile, normalized);
      written.push(outFile);
    }
  }
  return written;
}

function processRoot(root, rawArchive, outRoot) {
  return {
    claude_web: processClaudeExports(root, rawArchive, outRoot),
    gemini_web: processGeminiTakeout(root, rawArchive, outRoot)
  };
}

function maybeSync(outRoot) {
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'mcp', 'cli.js');
  const results = [];
  for (const dir of ['claude-web', 'gemini-web'].map((name) => path.join(outRoot, name))) {
    if (!fs.existsSync(dir)) continue;
    const output = childProcess.execFileSync(process.execPath, [cli, 'sync', '--dir', dir], { encoding: 'utf8' });
    results.push(JSON.parse(output));
  }
  return results;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(options.outRoot, { recursive: true });
  fs.mkdirSync(ARCHIVE_EXTRACT_DIR, { recursive: true });

  const inputs = discoverInputs(options.sources);
  const processed = [];
  const errors = [];

  for (const input of inputs) {
    try {
      const root = input.type === 'zip' ? extractZip(input.path, options.force) : input.path;
      const result = processRoot(root, input.path, options.outRoot);
      processed.push({
        input: input.path,
        type: input.type,
        extract_root: root,
        written: {
          claude_web: result.claude_web.length,
          gemini_web: result.gemini_web.length
        }
      });
    } catch (error) {
      errors.push({ input: input.path, error: error.message });
    }
  }

  const sync_results = options.sync ? maybeSync(options.outRoot) : [];
  console.log(JSON.stringify({
    outRoot: options.outRoot,
    archiveExtractDir: ARCHIVE_EXTRACT_DIR,
    processed,
    sync_results,
    errors
  }, null, 2));
  if (errors.length) process.exitCode = 2;
}

main();
