#!/usr/bin/env node
/**
 * edisnote-mcp            run the MCP server on stdio (what an agent launches)
 * edisnote-mcp install    register it with Claude Code, the Claude desktop app and Codex
 * edisnote-mcp check      show what the server can see, then exit
 *
 * Every form takes --dir <folder>. Without it, the folder is found on disk by
 * the marker Edisnote writes into whichever folder it syncs to.
 */

import { watch, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { serveStdio } from '../src/rpc.js';
import { createHandlers, listFingerprint, NAME, VERSION } from '../src/server.js';
import { locateFolder, loadVault } from '../src/vault.js';
import { codexHome, codexEntry, addCodexServer, codexBlock } from '../src/codex.js';
import { desktopConfigFiles, addDesktopServer } from '../src/claude-desktop.js';

const SKILL_MARKER = 'edisnote-mcp skill';
const NO_FOLDER = 'Turn on folder sync in Edisnote (the "Sync off" chip in the panel footer) and pick a folder, or pass --dir <folder>.';
const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'serve';

if (argv.includes('--version') || command === 'version') {
  console.log(VERSION);
} else if (!['serve', 'check', 'install'].includes(command)) {
  console.error(`Unknown command "${command}". Try: edisnote-mcp install | check | --version`);
  process.exitCode = 1;
} else {
  const located = await locateFolder(argv);
  if (command === 'serve') serve(located.root);
  else if (command === 'check') await check(located);
  else await install(located);
}

function serve(root) {
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

async function check({ root, how, found }) {
  const vault = await loadVault(root);
  if (!vault.found) {
    console.log(root ? `No folder at ${root}.` : 'No Edisnote folder found on this computer.');
    console.log(NO_FOLDER);
    process.exitCode = 1;
    return;
  }
  const images = vault.notes.reduce((sum, n) => sum + n.embeds.filter((e) => !e.remote).length, 0);
  console.log(`Edisnote folder: ${root}${how === 'found' ? '  (found on disk)' : ''}`);
  if (found.length > 1) {
    console.log(`Also found ${found.length - 1} other Edisnote folder(s); using the most recently synced:`);
    for (const other of found.slice(1)) console.log(`  ${other.dir}`);
  }
  console.log(`${vault.notes.length} notes, ${images} images embedded in them.`);
  for (const note of vault.notes.slice(0, 5)) console.log(`  ${note.title}  (${note.id})`);
  if (vault.notes.length > 5) console.log(`  …and ${vault.notes.length - 5} more`);
}

/**
 * Registers the server with Claude Code at user scope, so it works in every
 * project. Run through npx, it registers `npx -y edisnote-mcp` and so always
 * gets the published version; run from a checkout, it registers that checkout.
 *
 * The folder is pinned with --dir only when someone chose it: named it, or
 * picked one of several. Otherwise the server finds it at each start, so
 * pointing Edisnote at a new folder later needs no reinstall.
 */
async function install({ root, how, found }) {
  const self = fileURLToPath(import.meta.url);
  const viaNpx = /[\\/]_npx[\\/]/.test(self);
  // Plain `node`, not process.execPath: the full path is usually
  // C:\Program Files\..., and a space in the command is one more way for a
  // config file or shell to split it in two.
  const launch = viaNpx ? ['npx', '-y', 'edisnote-mcp'] : ['node', self];

  let pin = how === 'named';
  if (found.length > 1) {
    root = await pickFolder(found);
    pin = true;
  }
  const full = [...launch, ...(pin ? ['--dir', root] : [])];

  console.log(`Edisnote MCP ${VERSION}`);
  if (root) {
    console.log(`Reading ${root}${pin ? '' : '  (found on disk; it will follow the folder if you change it in Edisnote)'}\n`);
  } else {
    console.log(`No Edisnote folder found yet. ${NO_FOLDER}`);
    console.log('Installing anyway: it will find the folder once sync is on.\n');
  }

  const claude = runClaude(['mcp', 'add', '--scope', 'user', NAME, '--', ...full]);
  if (claude.status === 0) {
    console.log('Added to Claude Code for every project. Start a new session, then:');
    console.log('  /edisnote                     pick one of your recent notes');
    console.log('  /edisnote moodboard 2         the 2 newest images in that note');
    console.log('  /edisnote recent              what you just saved, from any note');
    console.log('  or just say "look at my Edisnote note on …"\n');
  } else if (/already exists/i.test(`${claude.stdout}${claude.stderr}`)) {
    console.log(`Claude Code already has a server called "${NAME}". To replace it:`);
    console.log(`  claude mcp remove ${NAME} --scope user`);
    console.log('  then run this again.\n');
  } else {
    console.log('Claude Code not found (or it refused). To add it by hand:');
    console.log(`  claude mcp add --scope user ${NAME} -- ${full.map(quote).join(' ')}\n`);
  }

  installSkill();
  installDesktop(full);
  installCodex(full);

  const [cmd, ...args] = full;
  console.log('For Cursor or any other MCP app, add this to its MCP config:');
  console.log(JSON.stringify({ mcpServers: { [NAME]: { command: cmd, args } } }, null, 2));
}

/**
 * Adds the server to the Claude desktop app's chat, which free users have and
 * which reads its own config file, not Claude Code's. Same launch entry as
 * Codex: the app starts servers without a shell (Windows needs `cmd /c npx`)
 * and, on a Mac, without the terminal's PATH. Old file kept as .backup.
 */
function installDesktop(full) {
  const entry = codexEntry(full);
  const files = desktopConfigFiles({ home: homedir() });
  const byHand = () => console.log(JSON.stringify({ mcpServers: { [NAME]: entry } }, null, 2));
  if (!files.length) {
    console.log('Claude desktop app not found. If you install it later, run this again, or paste this in Settings > Developer > Edit Config:');
    byHand();
    console.log('');
    return;
  }
  let added = false;
  for (const file of files) {
    try {
      const raw = existsSync(file) ? readFileSync(file, 'utf8') : '';
      const { status, text } = addDesktopServer(raw, NAME, entry);
      if (status === 'exists') {
        console.log(`The Claude desktop app already has a server called "${NAME}" (${file}). To replace it, delete that entry and run this again.
`);
        continue;
      }
      if (status === 'invalid') {
        console.log(`Left ${file} alone: it isn't valid JSON. Fix it, or add this to it by hand:`);
        byHand();
        console.log('');
        continue;
      }
      if (raw) writeFileSync(`${file}.backup`, raw);
      writeFileSync(file, text);
      console.log(`Added to the Claude desktop app (${file}).`);
      added = true;
    } catch (err) {
      console.log(`Couldn't update ${file} (${err.message}). In the app, open Settings > Developer > Edit Config and add:`);
      byHand();
      console.log('');
    }
  }
  if (added) {
    const quit = process.platform === 'win32' ? 'right-click the Claude icon by the clock and choose Quit' : 'press Cmd+Q';
    console.log(`Quit Claude fully (${quit}; closing the window isn't enough), open it again, then ask "look at my Edisnote note on …".
`);
  }
}

/**
 * Several Edisnote folders (an old one left behind, a second Chrome profile):
 * ask in a terminal, newest first as the default. With no terminal to ask in,
 * take the newest and say how to choose another.
 */
async function pickFolder(found) {
  console.log('Found more than one Edisnote folder:');
  found.forEach((f, i) => console.log(`  ${i + 1}. ${f.dir}${i === 0 ? '  (synced most recently)' : ''}`));
  if (!process.stdin.isTTY) {
    console.log('Using 1. To choose another, run install again with --dir "<folder>".\n');
    return found[0].dir;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Which one? [1-${found.length}, Enter for 1] `);
  rl.close();
  const n = Number.parseInt(answer, 10);
  console.log('');
  return found[n >= 1 && n <= found.length ? n - 1 : 0].dir;
}

/**
 * The Claude desktop app's message box lists skills under `/` but not MCP
 * prompts or resources, so without this the server is reachable there only by
 * asking in words. The skill is the `/edisnote` command for the desktop app.
 *
 * A file at that path without our marker is someone's own skill, and an
 * installer has no business replacing it.
 */
function installSkill() {
  const source = fileURLToPath(new URL('../skill/SKILL.md', import.meta.url));
  const dir = join(homedir(), '.claude', 'skills', 'edisnote');
  const target = join(dir, 'SKILL.md');
  const ours = readFileSync(source, 'utf8');
  if (existsSync(target)) {
    const current = readFileSync(target, 'utf8');
    if (current === ours) return console.log('The /edisnote skill is already up to date.\n');
    if (!current.includes(SKILL_MARKER)) {
      console.log(`Left ${target} alone: it isn't one this installer wrote.\n`);
      return;
    }
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(target, ours);
  console.log('Added the /edisnote skill. In the Claude desktop app, type /edisnote to pick a note.\n');
}

/**
 * Adds the server to Codex (CLI, IDE extension and the ChatGPT/Codex desktop
 * app all share one config). Only when Codex has been used on this computer,
 * which leaves its config folder behind; otherwise there's nothing to add to,
 * and creating the folder would leave clutter for people who don't use it.
 * The old file is kept as config.toml.backup.
 */
function installCodex(full) {
  const home = codexHome(process.env, homedir());
  const file = join(home, 'config.toml');
  const entry = codexEntry(full);
  if (!existsSync(home)) {
    console.log('Codex not found on this computer. If you use it later, run this again, or add this to ~/.codex/config.toml:');
    console.log(codexBlock(NAME, entry));
    return;
  }
  try {
    const raw = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const { status, text } = addCodexServer(raw, NAME, entry);
    if (status === 'exists') {
      console.log(`Codex already has a server called "${NAME}" (${file}). To replace it, delete its [mcp_servers.${NAME}] section and run this again.\n`);
      return;
    }
    if (raw) writeFileSync(`${file}.backup`, raw);
    writeFileSync(file, text);
    console.log(`Added to Codex (${file}). Restart the Codex or ChatGPT app, then ask "look at my Edisnote note on …".\n`);
  } catch (err) {
    console.log(`Couldn't update ${file} (${err.message}). Add this to it by hand:`);
    console.log(codexBlock(NAME, entry));
  }
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
