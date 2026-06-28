#!/usr/bin/env node
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_PROFILE = 'Default';
const DEFAULT_OUT_DIR = path.join(os.homedir(), 'Downloads', 'AI_Chats', 'perplexity-web');
const CHROME_ROOT = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
const GRAPHQL_URL = 'https://www.perplexity.ai/rest/perplexity_ask/graphql';
const THREAD_URL = 'https://www.perplexity.ai/rest/thread';
const USER_AGENT = 'Mozilla/5.0';

const LIBRARY_QUERY_HASH = 'bb88a4a60e88967f992b0c751b4ec9d28f7a7f00e06e16a8bda8a11448d734ec';
const PAGINATION_QUERY_HASH = 'e5321b427a2861e68f00c02e86a8d44e2fe132c1307ef386ecde8f67d9c40356';

function parseArgs(argv) {
  const options = {
    profile: DEFAULT_PROFILE,
    outDir: DEFAULT_OUT_DIR,
    limit: Infinity,
    concurrency: 4,
    force: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--profile') options.profile = argv[++index];
    else if (arg === '--out') options.outDir = argv[++index];
    else if (arg === '--limit') options.limit = Number(argv[++index]);
    else if (arg === '--concurrency') options.concurrency = Number(argv[++index]);
    else if (arg === '--force') options.force = true;
    else if (arg === '--help') {
      console.log(`Usage: node scripts/export-perplexity-web.js [--profile Default] [--out <dir>] [--limit <n>] [--concurrency <n>] [--force]`);
      process.exit(0);
    }
  }

  if (!Number.isFinite(options.concurrency) || options.concurrency < 1) options.concurrency = 4;
  return options;
}

function chromeCookieKey() {
  const password = childProcess.execFileSync('security', [
    'find-generic-password',
    '-w',
    '-s',
    'Chrome Safe Storage'
  ], { encoding: 'utf8' }).trim();
  return crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}

function readCookieRows(profile) {
  const db = path.join(CHROME_ROOT, profile, 'Cookies');
  if (!fs.existsSync(db)) {
    throw new Error(`Chrome cookie database not found: ${db}`);
  }

  const query = [
    'select host_key,name,value,hex(encrypted_value) as encrypted',
    'from cookies',
    "where host_key like '%perplexity.ai'"
  ].join(' ');
  const raw = childProcess.execFileSync('sqlite3', ['-json', db, query], { encoding: 'utf8' });
  return JSON.parse(raw || '[]');
}

function decryptCookie(row, key) {
  if (row.value) return row.value;

  const encrypted = Buffer.from(row.encrypted, 'hex');
  if (encrypted.subarray(0, 3).toString() !== 'v10') {
    throw new Error(`Unsupported Chrome cookie prefix for ${row.host_key}/${row.name}`);
  }

  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  let plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);

  // Current Chrome prepends SHA256(host_key) to decrypted cookie values on macOS.
  const hostHash = crypto.createHash('sha256').update(row.host_key).digest();
  if (plain.length > 32 && plain.subarray(0, 32).equals(hostHash)) {
    plain = plain.subarray(32);
  }

  return plain.toString('utf8');
}

function cookieHeader(profile) {
  const key = chromeCookieKey();
  const parts = [];
  let sessionCookieCount = 0;

  for (const row of readCookieRows(profile)) {
    const value = decryptCookie(row, key);
    if (value === undefined || value === null) continue;
    parts.push(`${row.name}=${value}`);
    if (row.name.includes('session')) sessionCookieCount += 1;
  }

  if (!sessionCookieCount) {
    throw new Error(`No Perplexity session cookies found in Chrome profile ${profile}`);
  }

  return parts.join('; ');
}

async function gql(cookie, operationName, variables, sha256Hash) {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
      origin: 'https://www.perplexity.ai',
      referer: 'https://www.perplexity.ai/library',
      'user-agent': USER_AGENT
    },
    body: JSON.stringify({
      operationName,
      variables,
      extensions: { persistedQuery: { version: 1, sha256Hash } }
    })
  });

  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    throw new Error(`Perplexity GraphQL ${operationName} failed: HTTP ${response.status} ${payload.errors?.[0]?.message || ''}`.trim());
  }
  return payload.data.viewer.recentGroup.threads;
}

async function listThreads(cookie, limit) {
  const threads = [];
  let cursor = null;
  let first = true;

  while (threads.length < limit) {
    const variables = {
      includeSearchPreview: false,
      searchTerm: null,
      sortOrder: 'NEWEST',
      statuses: null,
      threadTypes: null,
      sources: null,
      includeTemporary: null
    };

    const page = first
      ? await gql(cookie, 'LibraryThreadsRelayQuery', variables, LIBRARY_QUERY_HASH)
      : await gql(cookie, 'LibraryRecentThreadsPaginationQuery', {
          ...variables,
          count: 25,
          cursor
        }, PAGINATION_QUERY_HASH);

    for (const edge of page.edges || []) {
      if (edge?.node) threads.push(edge.node);
      if (threads.length >= limit) break;
    }

    if (!page.pageInfo?.hasNextPage || !page.pageInfo?.endCursor) break;
    cursor = page.pageInfo.endCursor;
    first = false;
  }

  return threads;
}

async function fetchThread(cookie, slug) {
  const entries = [];
  let cursor = null;
  let metadata = null;

  do {
    const params = new URLSearchParams({
      with_parent_info: 'false',
      with_schematized_response: 'true',
      version: '2.18',
      source: 'default',
      limit: '0',
      offset: '0',
      from_first: 'false'
    });
    if (cursor) params.set('cursor', cursor);

    const response = await fetch(`${THREAD_URL}/${encodeURIComponent(slug)}?${params}`, {
      headers: {
        cookie,
        referer: `https://www.perplexity.ai/search/${encodeURIComponent(slug)}`,
        'user-agent': USER_AGENT
      }
    });

    const payload = await response.json();
    if (!response.ok || payload.status === 'failed') {
      throw new Error(`Perplexity thread fetch failed for ${slug}: HTTP ${response.status}`);
    }

    entries.push(...(payload.entries || []));
    metadata ||= payload.thread_metadata || {};
    cursor = payload.has_next_page ? payload.next_cursor : null;
  } while (cursor);

  return { entries, metadata };
}

function cleanText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function firstLine(value, max = 140) {
  const line = cleanText(value).split('\n').find(Boolean) || 'Untitled Perplexity chat';
  return line.length > max ? `${line.slice(0, max - 1)}...` : line;
}

function extractAnswer(entry) {
  const answers = [];
  for (const block of entry.blocks || []) {
    const answer = block?.markdown_block?.answer;
    if (answer) answers.push(cleanText(answer));
  }

  const unique = [];
  for (const answer of answers.sort((a, b) => b.length - a.length)) {
    if (!answer) continue;
    if (unique.some((existing) => existing.includes(answer) || answer.includes(existing))) continue;
    unique.push(answer);
  }

  if (unique.length) return unique.join('\n\n---\n\n');
  return cleanText(entry.answer || entry.text || entry.gpt4 || '');
}

function extractSources(entry) {
  const results = [];
  const seen = new Set();
  for (const block of entry.blocks || []) {
    for (const source of block?.web_result_block?.web_results || []) {
      const url = source.url || source.source_url || source.link;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      results.push({
        title: source.name || source.title || '',
        url,
        snippet: source.snippet || source.preview || ''
      });
    }
  }
  return results;
}

function normalizeThread(node, payload) {
  const slug = node.slug || node.contextUUID || node.entryId;
  const messages = [];

  payload.entries.forEach((entry, entryIndex) => {
    const createdAt = entry.entry_created_datetime || entry.updated_datetime || payload.metadata?.created_at || node.updatedAt;
    const query = cleanText(entry.query_str);
    const answer = extractAnswer(entry);
    const sources = extractSources(entry);

    if (query) {
      messages.push({
        role: 'user',
        content: query,
        created_at: createdAt,
        index: messages.length,
        metadata: {
          entry_uuid: entry.uuid || null,
          backend_uuid: entry.backend_uuid || null,
          thread_slug: slug,
          entry_index: entryIndex
        }
      });
    }

    if (answer) {
      messages.push({
        role: 'assistant',
        content: answer,
        created_at: entry.entry_updated_datetime || entry.updated_datetime || createdAt,
        index: messages.length,
        metadata: {
          entry_uuid: entry.uuid || null,
          backend_uuid: entry.backend_uuid || null,
          thread_slug: slug,
          entry_index: entryIndex,
          sources
        }
      });
    }
  });

  return {
    provider: 'perplexity',
    title: firstLine(node.name || payload.metadata?.title || payload.entries[0]?.query_str),
    source: 'perplexity-web',
    source_url: `https://www.perplexity.ai/search/${slug}`,
    captured_at: new Date().toISOString(),
    schema_version: 'ai-chat-vault.normalized.v1',
    conversation: {
      provider: 'perplexity',
      title: firstLine(node.name || payload.metadata?.title || payload.entries[0]?.query_str),
      source_url: `https://www.perplexity.ai/search/${slug}`,
      captured_at: new Date().toISOString(),
      metadata: {
        source: 'perplexity-web',
        slug,
        context_uuid: node.contextUUID || null,
        entry_id: node.entryId || null,
        updated_at: node.updatedAt || payload.metadata?.updated_at || null,
        status: node.status || payload.metadata?.thread_status || null
      }
    },
    messages
  };
}

function safeName(value) {
  return String(value || 'thread')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'thread';
}

async function pool(items, concurrency, worker) {
  const results = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(options.outDir, { recursive: true });

  const cookie = cookieHeader(options.profile);
  const threads = await listThreads(cookie, options.limit);
  let written = 0;
  let skipped = 0;
  const errors = [];

  await pool(threads, options.concurrency, async (node) => {
    const slug = node.slug || node.contextUUID || node.entryId;
    const file = path.join(options.outDir, `${safeName(slug)}.json`);
    if (!options.force && fs.existsSync(file)) {
      skipped += 1;
      return;
    }

    try {
      const payload = await fetchThread(cookie, slug);
      const normalized = normalizeThread(node, payload);
      if (!normalized.messages.length) {
        skipped += 1;
        return;
      }
      fs.writeFileSync(file, `${JSON.stringify(normalized, null, 2)}\n`);
      written += 1;
    } catch (error) {
      errors.push({ slug, message: error.message });
    }
  });

  console.log(JSON.stringify({
    provider: 'perplexity',
    profile: options.profile,
    outDir: options.outDir,
    discovered_threads: threads.length,
    written,
    skipped,
    errors
  }, null, 2));

  if (errors.length) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
