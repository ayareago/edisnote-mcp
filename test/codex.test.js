import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { codexHome, codexEntry, addCodexServer } from '../src/codex.js';

const NPX = ['npx', '-y', 'edisnote-mcp'];

test('codex home: CODEX_HOME wins, else ~/.codex', () => {
  assert.equal(codexHome({ CODEX_HOME: '/x' }, '/home/a'), '/x');
  assert.equal(codexHome({}, '/home/a'), join('/home/a', '.codex'));
});

test('codex entry: Windows wraps npx in cmd /c, keeps --dir as one argument', () => {
  const e = codexEntry([...NPX, '--dir', 'D:\\My Notes'], { platform: 'win32', execPath: 'C:\\node\\node.exe' });
  assert.deepEqual(e, { command: 'cmd', args: ['/c', 'npx', '-y', 'edisnote-mcp', '--dir', 'D:\\My Notes'] });
});

test('codex entry: Mac uses the npx beside this Node and a PATH that has it', () => {
  const e = codexEntry(NPX, { platform: 'darwin', execPath: '/Users/a/.nvm/versions/node/v22/bin/node' });
  assert.equal(e.command, join('/Users/a/.nvm/versions/node/v22/bin', 'npx'));
  assert.deepEqual(e.args, ['-y', 'edisnote-mcp']);
  assert.ok(e.env.PATH.startsWith('/Users/a/.nvm/versions/node/v22/bin:'));
  assert.ok(e.env.PATH.includes('/opt/homebrew/bin'));
});

test('codex entry: a local checkout runs with the full node path', () => {
  const e = codexEntry(['node', '/src/bin/edisnote-mcp.js'], { platform: 'win32', execPath: 'C:\\Program Files\\nodejs\\node.exe' });
  assert.deepEqual(e, { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['/src/bin/edisnote-mcp.js'] });
});

test('codex config: appends a table and leaves the rest byte for byte', () => {
  const raw = 'model = "gpt-5"\r\n\r\n[mcp_servers.figma]\r\ncommand = "x"';
  const entry = { command: 'cmd', args: ['/c', 'npx', '-y', 'edisnote-mcp', '--dir', 'D:\\My "Notes"'] };
  const { status, text } = addCodexServer(raw, 'edisnote', entry);
  assert.equal(status, 'added');
  assert.ok(text.startsWith(`${raw}\n`));
  assert.match(text, /\[mcp_servers\.edisnote\]\ncommand = "cmd"\nargs = \["\/c", "npx", "-y", "edisnote-mcp", "--dir", "D:\\\\My \\"Notes\\""\]\nstartup_timeout_sec = 60\n$/);
});

test('codex config: env goes in its own sub-table; empty file gets no blank first line', () => {
  const { text } = addCodexServer('', 'edisnote', { command: '/b/npx', args: ['-y'], env: { PATH: '/b:/bin' } });
  assert.ok(text.startsWith('# Added by edisnote-mcp install\n[mcp_servers.edisnote]\n'));
  assert.ok(text.endsWith('\n[mcp_servers.edisnote.env]\nPATH = "/b:/bin"\n'));
});

test('codex config: an existing edisnote table, quoted or not, is never touched', () => {
  for (const raw of ['[mcp_servers.edisnote]\ncommand = "mine"\n', 'a = 1\n  [mcp_servers."edisnote"]\n']) {
    assert.deepEqual(addCodexServer(raw, 'edisnote', { command: 'x', args: [] }), { status: 'exists', text: raw });
  }
  assert.equal(addCodexServer('[mcp_servers.edisnote-old]\n', 'edisnote', { command: 'x', args: [] }).status, 'added');
});
