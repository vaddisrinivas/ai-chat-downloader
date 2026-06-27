#!/usr/bin/env node
import readline from 'node:readline';
import {
  buildContextPack,
  dailyCheck,
  getConversation,
  importFile,
  listConversations,
  searchChats,
  syncExports
} from './store.js';

const tools = [
  {
    name: 'sync_exports',
    description: 'Import changed AI chat exports from configured folders into the local chat vault.',
    inputSchema: {
      type: 'object',
      properties: {
        dirs: { type: 'array', items: { type: 'string' } },
        force: { type: 'boolean' }
      }
    }
  },
  {
    name: 'import_paths',
    description: 'Import specific Markdown or normalized JSON chat export files.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' } }
      },
      required: ['paths']
    }
  },
  {
    name: 'search_chats',
    description: 'Search imported AI conversations across providers.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        provider: { type: 'string' },
        limit: { type: 'number' }
      },
      required: ['query']
    }
  },
  {
    name: 'list_conversations',
    description: 'List recently imported conversations.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string' },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: 'get_conversation',
    description: 'Return a full conversation and messages by conversation id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }
      },
      required: ['id']
    }
  },
  {
    name: 'build_context_pack',
    description: 'Build a compact markdown context pack from matching historical chats.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        provider: { type: 'string' },
        max_chars: { type: 'number' }
      },
      required: ['query']
    }
  },
  {
    name: 'daily_check',
    description: 'Return vault counts, provider breakdown, last sync, and newest conversations.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
];

function toTextContent(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

function callTool(name, args = {}) {
  if (name === 'sync_exports') return syncExports(args);
  if (name === 'import_paths') return args.paths.map((file) => importFile(file));
  if (name === 'search_chats') return searchChats(args);
  if (name === 'list_conversations') return listConversations(args);
  if (name === 'get_conversation') return getConversation(args.id);
  if (name === 'build_context_pack') return buildContextPack(args);
  if (name === 'daily_check') return dailyCheck();
  throw new Error(`Unknown tool: ${name}`);
}

function respond(id, result) {
  if (id === undefined || id === null) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function respondError(id, error) {
  if (id === undefined || id === null) return;
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: error.message
    }
  })}\n`);
}

async function handle(message) {
  const { id, method, params = {} } = message;

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: {
        name: 'ai-chat-vault',
        version: '0.1.0'
      }
    });
    return;
  }

  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') {
    respond(id, { tools });
    return;
  }

  if (method === 'tools/call') {
    const result = callTool(params.name, params.arguments || {});
    respond(id, toTextContent(result));
    return;
  }

  respondError(id, new Error(`Unsupported method: ${method}`));
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stderr,
  terminal: false
});

rl.on('line', async (line) => {
  if (!line.trim()) return;
  try {
    await handle(JSON.parse(line));
  } catch (error) {
    respondError(null, error);
  }
});
