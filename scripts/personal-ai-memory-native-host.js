#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VAULT_HOME = process.env.AI_CHAT_VAULT_HOME || path.join(os.homedir(), '.ai-chat-vault');
const IMPORT_DIR = process.env.AI_CHAT_PERSONAL_MEMORY_EXPORT_DIR || path.join(VAULT_HOME, 'personal-ai-memory-imports');
const MANIFEST_FILE = path.join(IMPORT_DIR, 'manifest.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST_FILE)) {
    throw new Error(`Personal AI Memory manifest not found: ${MANIFEST_FILE}`);
  }
  return readJson(MANIFEST_FILE);
}

function sourceFingerprint() {
  const file = path.join(VAULT_HOME, 'messages.jsonl');
  const stat = fs.statSync(file);
  return `${stat.size}:${Math.floor(stat.mtimeMs)}`;
}

function loadRecords(offset = 0, limit = 500) {
  const manifest = loadManifest();
  const total = Number(manifest.records || 0);
  const chunkSize = Number(manifest.chunk_size || 25000);
  let remaining = Math.max(1, Number(limit || 500));
  let cursor = Math.max(0, Number(offset || 0));
  const records = [];

  while (remaining > 0 && cursor < total) {
    const chunkIndex = Math.floor(cursor / chunkSize);
    const localOffset = cursor % chunkSize;
    const file = manifest.files?.[chunkIndex];
    if (!file) break;
    const payload = readJson(file).payload || [];
    const slice = payload.slice(localOffset, localOffset + remaining);
    records.push(...slice);
    remaining -= slice.length;
    cursor += slice.length;
    if (slice.length === 0) break;
  }

  return {
    ok: true,
    records,
    offset,
    next_offset: cursor,
    total,
    done: cursor >= total,
    generated_at: manifest.generated_at,
    source_fingerprint: manifest.source_fingerprint || sourceFingerprint()
  };
}

function handle(message) {
  if (!message || typeof message !== 'object') return { ok: false, error: 'Invalid message' };
  if (message.type === 'manifest') {
    const manifest = loadManifest();
    return {
      ok: true,
      records: manifest.records,
      tool_records: manifest.tool_records,
      chunk_count: manifest.chunk_count,
      chunk_size: manifest.chunk_size,
      generated_at: manifest.generated_at,
      source_fingerprint: manifest.source_fingerprint || sourceFingerprint()
    };
  }
  if (message.type === 'records') {
    return loadRecords(message.offset, message.limit);
  }
  return { ok: false, error: `Unknown message type: ${message.type}` };
}

function readMessage() {
  const header = Buffer.alloc(4);
  const bytesRead = fs.readSync(0, header, 0, 4, null);
  if (bytesRead === 0) return null;
  if (bytesRead !== 4) throw new Error('Truncated native messaging header');
  const length = header.readUInt32LE(0);
  const body = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const n = fs.readSync(0, body, offset, length - offset, null);
    if (n === 0) throw new Error('Truncated native messaging body');
    offset += n;
  }
  return JSON.parse(body.toString('utf8'));
}

function writeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  fs.writeSync(1, header);
  fs.writeSync(1, body);
}

while (true) {
  try {
    const message = readMessage();
    if (message === null) break;
    writeMessage(handle(message));
  } catch (error) {
    writeMessage({ ok: false, error: error.message });
  }
}

