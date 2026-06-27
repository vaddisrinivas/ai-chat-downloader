#!/usr/bin/env node
import { buildContextPack, dailyCheck, importFile, searchChats, syncExports } from './store.js';

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
    else if (arg === '--dir') {
      options.dirs ||= [];
      options.dirs.push(args[++index]);
    } else if (arg === '--force') options.force = true;
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
  ai-chat-vault sync [--dir <path>] [--force] [--watch-24h]
  ai-chat-vault search <query> [--provider <name>] [--limit <n>]
  ai-chat-vault context <query> [--provider <name>] [--max-chars <n>]
  ai-chat-vault check`);
    return;
  }

  if (command === 'import') {
    print(rest.map((file) => importFile(file)));
    return;
  }

  if (command === 'sync') {
    const run = () => print(syncExports(options));
    run();
    if (options.watch24h) {
      setInterval(run, 24 * 60 * 60 * 1000);
    }
    return;
  }

  if (command === 'search') {
    print(searchChats({ ...options, query: rest.join(' ') }));
    return;
  }

  if (command === 'context') {
    print(buildContextPack({ ...options, query: rest.join(' ') }));
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
