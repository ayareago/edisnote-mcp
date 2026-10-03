#!/usr/bin/env node
/**
 * edisnote-mcp            run the MCP server on stdio (what an agent launches)
 * edisnote-mcp install    register it with Claude Code, print config for others
 * edisnote-mcp check      show what the server can see, then exit
 *
 * Every form takes --dir <folder>; the default is Documents\Notes.
 */

import { watch } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serveStdio } from '../src/rpc.js';
import { createHandlers, listFingerprint, NAME, VERSION } from '../src/server.js';
import { chooseFolder, loadVault, defaultFolder } from '../src/vault.js';

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'serve';
const root = chooseFolder(argv);

if (argv.includes('--version') || command === 'version') {
  console.log(VERSION);
} else if (command === 'serve') {
  serve();
} else if (command === 'check') {
  await check();
} else if (command === 'install') {
  install();
} else {
  console.error(`Unknown command "${command}". Try: edisnote-mcp install | check | --version`);
  process.exitCode = 1;
}

function serve() {
  const { notify, closed } = serveStdio(createHandlers(root));

  // New notes should show up in the @ list without restarting the agent. The
  // extension writes two seconds after every keystroke, so the folder is busy;
  // the fingerprint means a notification goes out only when the list itself
  // (ids, titles, image counts) actually changed.
  let last = null;
  let timer = null;
  listFingerprint(root).then((f) => (last = f));
  const recheck = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const next = await listFingerprint(root).catch(() => last);
      if (last !== null && next !== last) notify('notifications/resources/list_changed');
      last = next;
    }, 750);
  };
  let watcher = null;
  try {
    watcher = watch(root, { recursive: true }, recheck);
    watcher.on('error', () => watcher?.close());
  } catch {
    // Folder missing or recursive watch unsupported: the list still refreshes
    // whenever the client asks, it just isn't pushed.
  }
  closed.then(() => {
    watcher?.close();
    clearTimeout(timer);
    process.exit(0);
  });
}

async function check() {
  const vault = await loadVault(root);
  if (!vault.found) {
    console.log(`No folder at ${root}.`);
    console.log('Turn on folder sync in Edisnote (the "Sync off" chip), or pass --dir <folder>.');
    process.exitCode = 1;
    return;
  }
  const images = vault.notes.reduce((sum, n) => sum + n.embeds.filter((e) => !e.remote).length, 0);
  console.log(`Edisnote folder: ${root}`);
  console.log(`${vault.notes.length} notes, ${images} images embedded in them.`);
  for (const note of vault.notes.slice(0, 5)) console.log(`  ${note.title}  (${note.id})`);
  if (vault.notes.length > 5) console.log(`  …and ${vault.notes.length - 5} more`);
}

/**
 * Registers the server with Claude Code at user scope, so it works in every
 * project. Run through npx, it registers `npx -y edisnote-mcp` and so always
 * gets the published version; run from a checkout, it registers that checkout.
 */
function install() {
  const self = fileURLToPath(import.meta.url);
  const viaNpx = /[\\/]_npx[\\/]/.test(self);
  // Plain `node`, not process.execPath: the full path is usually
  // C:\Program Files\..., and a space in the command is one more way for a
  // config file or shell to split it in two.
  const launch = viaNpx ? ['npx', '-y', 'edisnote-mcp'] : ['node', self];
  const dirArgs = root !== defaultFolder() ? ['--dir', root] : [];
  const full = [...launch, ...dirArgs];

  console.log(`Edisnote MCP ${VERSION} — reading ${root}\n`);

  const claude = runClaude(['mcp', 'add', '--scope', 'user', NAME, '--', ...full]);
  if (claude.status === 0) {
    console.log('Added to Claude Code for every project. Start a new session, then:');
    console.log('  @          pick a note from the list');
    console.log('  /edisnote:latest <note>   the newest image in a note');
    console.log('  or just say "look at my Edisnote note on …"\n');
  } else if (/already exists/i.test(`${claude.stdout}${claude.stderr}`)) {
    console.log(`Claude Code already has a server called "${NAME}". To replace it:`);
    console.log(`  claude mcp remove ${NAME} --scope user`);
    console.log('  then run this again.\n');
  } else {
    console.log('Claude Code not found (or it refused). To add it by hand:');
    console.log(`  claude mcp add --scope user ${NAME} -- ${full.map(quote).join(' ')}\n`);
  }

  const [cmd, ...args] = full;
  console.log('For Cursor, Claude Desktop or any other MCP app, add this to its MCP config:');
  console.log(JSON.stringify({ mcpServers: { [NAME]: { command: cmd, args } } }, null, 2));
}

/**
 * Runs the claude CLI without a shell first: through one, Node joins the args
 * with spaces unescaped, and the first install registered "C:\Program" as the
 * command. Only a Windows install that is a .cmd shim (npm's) needs the shell,
 * and then every argument is quoted by hand.
 */
function runClaude(args) {
  const direct = spawnSync('claude', args, { encoding: 'utf8' });
  if (!direct.error || process.platform !== 'win32') return direct;
  const line = ['claude', ...args].map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(' ');
  return spawnSync(line, { encoding: 'utf8', shell: true });
}

function quote(arg) {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}
