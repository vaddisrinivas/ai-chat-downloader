#!/usr/bin/env node
import { readRawRef, syncLocalSources } from './local-sources.js';
import { buildContextPack, dailyCheck, importFile, searchChats, searchToolCalls, syncExports, toolCallStats } from './store.js';

function print(value) {
  if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

function parseOptions(args) {
  const options = {};
  const rest = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--provider') options.provider = args[++index];
    else if (arg === '--limit') options.limit = Number(args[++index]);
    else if (arg === '--max-chars') options.max_chars = Number(args[++index]);
    else if (arg === '--line') options.line = Number(args[++index]);
    else if (arg === '--tool') options.tool = args[++index];
    else if (arg === '--kind') options.kind = args[++index];
    else if (arg === '--dir') {
      options.dirs ||= [];
      options.dirs.push(args[++index]);
    } else if (arg === '--all') options.all = true;
    else if (arg === '--local') options.local = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--watch-24h') options.watch24h = true;
    else rest.push(arg);
  }
  return { options, rest };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const { options, rest } = parseOptions(args);

  if (!command || command === 'help') {
    print(`Usage:
  ai-chat-vault import <file...>
  ai-chat-vault sync [--all|--local] [--dir <path>] [--force] [--watch-24h]
  ai-chat-vault search <query> [--provider <name>] [--limit <n>]
  ai-chat-vault tools [query] [--provider <name>] [--tool <name>] [--kind call|result] [--limit <n>]
  ai-chat-vault tool-stats [--provider <name>] [--limit <n>]
  ai-chat-vault context <query> [--provider <name>] [--max-chars <n>]
  ai-chat-vault raw <source-file> [--line <n>] [--max-chars <n>]
  ai-chat-vault check`);
    return;
  }

  if (command === 'import') {
    print(rest.map((file) => importFile(file)));
    return;
  }

  if (command === 'sync') {
    const run = async () => {
      if (options.all) {
        print({
          exports: syncExports(options),
          local_sources: await syncLocalSources(options)
        });
      } else if (options.local) {
        print(await syncLocalSources(options));
      } else {
        print(syncExports(options));
      }
    };
    await run();
    if (options.watch24h) {
      setInterval(run, 24 * 60 * 60 * 1000);
    }
    return;
  }

  if (command === 'search') {
    print(searchChats({ ...options, query: rest.join(' ') }));
    return;
  }

  if (command === 'tools') {
    print(searchToolCalls({ ...options, query: rest.join(' ') }));
    return;
  }

  if (command === 'tool-stats') {
    print(toolCallStats(options));
    return;
  }

  if (command === 'context') {
    print(buildContextPack({ ...options, query: rest.join(' ') }));
    return;
  }

  if (command === 'raw') {
    print(readRawRef({ ...options, source_file: rest.join(' ') }));
    return;
  }

  if (command === 'check') {
    print(dailyCheck());
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
