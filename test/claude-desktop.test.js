import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { desktopConfigFiles, addDesktopServer } from '../src/claude-desktop.js';

const ENTRY = { command: 'cmd', args: ['/c', 'npx', '-y', 'edisnote-mcp'] };
const HOME = 'C:\\Users\\a';
const env = { APPDATA: join(HOME, 'AppData', 'Roaming'), LOCALAPPDATA: join(HOME, 'AppData', 'Local') };

/** A fake disk: a set of paths that exist, and the folder listings. */
function disk(paths) {
  const set = new Set(paths.map((p) => p.toLowerCase()));
  return {
    existsSync: (p) => set.has(p.toLowerCase()),
    readdirSync: (dir) => {
      const prefix = `${dir.toLowerCase()}\\`;
      const names = paths.filter((p) => p.toLowerCase().startsWith(prefix)).map((p) => p.slice(prefix.length).split('\\')[0]);
      if (!names.length && !set.has(dir.toLowerCase())) throw new Error('ENOENT');
      return [...new Set(names)];
    },
  };
}
const files = (paths) => desktopConfigFiles({ platform: 'win32', env, home: HOME, fs: disk(paths) });

test('desktop: newer Windows builds keep the config in Claude-Data, pointed to by a marker', () => {
  const roaming = join(env.APPDATA, 'Claude');
  const data = join(env.LOCALAPPDATA, 'Claude-Data', 'claude_abc');
  assert.deepEqual(files([roaming, join(roaming, '.user-data-left.claude_abc'), data, join(data, 'claude_desktop_config.json')]), [
    join(data, 'claude_desktop_config.json'),
  ]);
  // Opened but never configured: create it there, not in the abandoned Roaming folder.
  assert.deepEqual(files([roaming, join(roaming, '.user-data-left.claude_abc'), data]), [join(data, 'claude_desktop_config.json')]);
});

test('desktop: classic and Store installs', () => {
  const roaming = join(env.APPDATA, 'Claude');
  assert.deepEqual(files([roaming]), [join(roaming, 'claude_desktop_config.json')]);
  const store = join(env.LOCALAPPDATA, 'Packages', 'Claude_xyz', 'LocalCache', 'Roaming', 'Claude');
  assert.deepEqual(files([store, join(store, 'claude_desktop_config.json')]), [join(store, 'claude_desktop_config.json')]);
});

test('desktop: every existing config gets it; no Claude at all means none', () => {
  const roaming = join(env.APPDATA, 'Claude');
  const store = join(env.LOCALAPPDATA, 'Packages', 'Claude_xyz', 'LocalCache', 'Roaming', 'Claude');
  const both = files([roaming, join(roaming, 'claude_desktop_config.json'), store, join(store, 'claude_desktop_config.json')]);
  assert.equal(both.length, 2);
  assert.deepEqual(files([]), []);
});

test('desktop: Mac path, and nothing on Linux', () => {
  const dir = join('/Users/a', 'Library', 'Application Support', 'Claude');
  const fs = { existsSync: (p) => p === dir, readdirSync: () => [] };
  assert.deepEqual(desktopConfigFiles({ platform: 'darwin', home: '/Users/a', fs }), [join(dir, 'claude_desktop_config.json')]);
  assert.deepEqual(desktopConfigFiles({ platform: 'linux', home: '/home/a', fs }), []);
});

test('desktop config: adds the server and keeps other servers and keys', () => {
  const raw = JSON.stringify({ mcpServers: { figma: { command: 'x', args: [] } }, preferences: { a: 1 } });
  const { status, text } = addDesktopServer(raw, 'edisnote', ENTRY);
  assert.equal(status, 'added');
  const out = JSON.parse(text);
  assert.deepEqual(out.mcpServers.figma, { command: 'x', args: [] });
  assert.deepEqual(out.mcpServers.edisnote, ENTRY);
  assert.deepEqual(out.preferences, { a: 1 });
});

test('desktop config: empty or missing file starts fresh', () => {
  for (const raw of ['', '  \n']) {
    assert.deepEqual(JSON.parse(addDesktopServer(raw, 'edisnote', ENTRY).text), { mcpServers: { edisnote: ENTRY } });
  }
});

test('desktop config: an existing entry or a broken file is never rewritten', () => {
  const mine = '{"mcpServers":{"edisnote":{"command":"mine"}}}';
  assert.deepEqual(addDesktopServer(mine, 'edisnote', ENTRY), { status: 'exists', text: mine });
  for (const raw of ['{ "mcpServers": {', '[]', '{"mcpServers": []}']) {
    assert.deepEqual(addDesktopServer(raw, 'edisnote', ENTRY), { status: 'invalid', text: raw });
  }
});
