import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHandlers, listFingerprint } from '../src/server.js';
import { dispatch, serveStdio } from '../src/rpc.js';
import { loadVault, imagesOf, chooseFolder, isInside } from '../src/vault.js';
import { makeVault, PNG, BOARD_LATE, BOARD_ONLY } from './fixture.js';

let vault;
let h;
before(async () => {
  vault = await makeVault();
  h = createHandlers(vault.root);
});
after(() => vault.cleanup());

const call = async (name, args) => (await h['tools/call']({ name, arguments: args })).content;
const texts = (content) => content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const images = (content) => content.filter((c) => c.type === 'image');

test('listing skips attachments, collections and dot-folders but finds subfolders', async () => {
  const { notes } = await loadVault(vault.root);
  assert.deepEqual(notes.map((n) => n.id).sort(), ['apex-buffet', 'apex-signage', 'food-board', 'projects/nested']);
  assert.equal(notes.find((n) => n.id === 'apex-buffet').title, 'Apex Buffet'); // from the # heading
});

test('a note can never reach a file outside the folder', async () => {
  const { notes } = await loadVault(vault.root);
  const food = notes.find((n) => n.id === 'food-board');
  const { images: found } = await imagesOf(vault.root, food);
  for (const img of found) {
    if (img.abs) assert.ok(isInside(vault.root, img.abs), `${img.abs} escaped`);
  }
  assert.ok(!found.some((img) => img.abs?.endsWith('secret.png')));
  const missing = found.filter((img) => !img.abs).map((img) => img.target);
  assert.deepEqual(missing.sort(), ['../secret.png', 'attachments/gone.png']);
});

test('bare wiki names resolve into attachments/, the way Obsidian finds them', async () => {
  const { notes } = await loadVault(vault.root);
  const { images: found } = await imagesOf(vault.root, notes.find((n) => n.id === 'food-board'));
  assert.equal(found.find((img) => img.target === 'loose.png').rel, 'attachments/loose.png');
});

test('read_note: text with markers, sources, list, newest images inline', async () => {
  const content = await call('read_note', { note: 'food board', images: 2 });
  const text = texts(content);
  assert.match(text, /# Food Board/);
  assert.match(text, /- https:\/\/www\.pinterest\.com\/pin\/1\//);
  assert.match(text, /Warm reds for the menu\. \[image 1\]/);
  assert.match(text, /\[web image: https:\/\/cdn\.example\.com\/remote\.jpg\]/);
  assert.match(text, /MISSING/);
  // The two newest are loose.png and the svg (equal mtimes, so reading order
  // breaks the tie). "Newest 2" stays honest: one picture, one path.
  assert.match(text, /Shown below: images 3, 4/);
  assert.equal(images(content).length, 1);
  assert.equal(images(content)[0].mimeType, 'image/png');
  assert.equal(Buffer.from(images(content)[0].data, 'base64').compare(PNG), 0);
});

test('read_note: an svg is listed by path, never sent as an image', async () => {
  const content = await call('view_images', { note: 'food-board', numbers: [3] });
  assert.equal(images(content).length, 0);
  assert.match(texts(content), /\.svg can't be shown inline/);
});

test('board: every board image counted, newest by the id timestamp, cards kept', async () => {
  const content = await call('read_note', { note: 'apex-signage', images: 1 });
  const text = texts(content);
  assert.match(text, /## Board: Refs/);
  assert.match(text, /my own Obsidian note/);
  assert.match(text, /## Images \(3\)/); // two in the gallery + one only on the board
  assert.ok(text.includes(BOARD_ONLY));
  assert.match(text, /Shown below: image 2 \(the newest\)/);
  assert.ok(text.includes(BOARD_LATE.split('/')[1]));
});

test('ambiguous names ask instead of guessing', async () => {
  const res = await h['tools/call']({ name: 'read_note', arguments: { note: 'apex' } });
  assert.equal(res.isError, true);
  assert.match(texts(res.content), /matches 2 notes/);
});

test('view_images rejects numbers that do not exist', async () => {
  const res = await h['tools/call']({ name: 'view_images', arguments: { note: 'food-board', numbers: [99] } });
  assert.equal(res.isError, true);
  assert.match(texts(res.content), /there is no 99/);
});

test('recent_images is newest first across notes', async () => {
  const content = await call('recent_images', { count: 1 });
  assert.equal(images(content).length, 1);
});

test('missing folder explains how to turn sync on', async () => {
  const lost = createHandlers(join(vault.base, 'nope'));
  const res = await lost['tools/call']({ name: 'list_notes', arguments: {} });
  assert.equal(res.isError, true);
  assert.match(texts(res.content), /Sync off/);
  assert.deepEqual((await lost['resources/list']()).resources, []);
});

test('resources: one per note, read returns text then image blobs', async () => {
  const { resources } = await h['resources/list']();
  assert.ok(resources.some((r) => r.uri === 'note://projects/nested'));
  assert.equal(resources[0].uri, 'recent://images');
  const { contents } = await h['resources/read']({ uri: 'note://food-board' });
  assert.equal(contents[0].mimeType, 'text/markdown');
  assert.ok(contents.some((c) => c.blob && c.mimeType === 'image/png'));
  await assert.rejects(h['resources/read']({ uri: 'note://nope' }), /not found/);
});

test('prompts: latest returns the newest image as a message', async () => {
  const { messages } = await h['prompts/get']({ name: 'latest', arguments: { note: 'apex-signage', count: '1' } });
  assert.match(messages[0].content.text, /newest image/);
  assert.equal(messages.filter((m) => m.content.type === 'image').length, 1);
  await assert.rejects(h['prompts/get']({ name: 'latest', arguments: { note: 'apex' } }), /matches 2 notes/);
});

test('completion suggests note ids for the note argument only', async () => {
  const { completion } = await h['completion/complete']({ ref: { type: 'ref/prompt', name: 'use' }, argument: { name: 'note', value: 'apex' } });
  assert.deepEqual(completion.values.sort(), ['apex-buffet', 'apex-signage']);
  const none = await h['completion/complete']({ ref: { type: 'ref/prompt', name: 'recent' }, argument: { name: 'count', value: '' } });
  assert.deepEqual(none.completion.values, []);
});

test('initialize echoes a version it knows and falls back otherwise', () => {
  assert.equal(h.initialize({ protocolVersion: '2025-06-18' }).protocolVersion, '2025-06-18');
  assert.equal(h.initialize({ protocolVersion: '1999-01-01' }).protocolVersion, '2025-11-25');
});

test('fingerprint ignores mtime churn and moves when the list changes', async () => {
  const a = await listFingerprint(vault.root);
  assert.equal(await listFingerprint(vault.root), a);
  const { writeFile, rm } = await import('node:fs/promises');
  const extra = join(vault.root, 'new-one.md');
  await writeFile(extra, 'hi');
  assert.notEqual(await listFingerprint(vault.root), a);
  await rm(extra);
});

test('rpc: notifications get no reply, unknown methods get -32601', async () => {
  assert.equal(await dispatch(h, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const reply = await dispatch(h, { jsonrpc: '2.0', id: 9, method: 'nope' });
  assert.equal(reply.error.code, -32601);
  const proto = await dispatch(h, { jsonrpc: '2.0', id: 10, method: 'constructor' });
  assert.equal(proto.error.code, -32601);
});

// Regression: exiting on stdin 'close' dropped every reply still being worked
// out, so piping three requests in returned one answer.
test('rpc: replies in flight when stdin closes are still sent', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.on('data', (d) => (out += d));
  const { closed } = serveStdio(h, { input, output });
  for (let id = 1; id <= 3; id++) input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'list_notes', arguments: {} } })}\n`);
  input.end();
  await closed;
  assert.equal(out.trim().split('\n').length, 3);
});

test('folder choice: --dir beats env beats default, ~ expands', () => {
  assert.equal(chooseFolder(['--dir', '/x/y'], { EDISNOTE_DIR: '/env' }), resolve('/x/y'));
  assert.equal(chooseFolder([], { EDISNOTE_DIR: '/env' }), resolve('/env'));
  assert.equal(chooseFolder([], {}), resolve(homedir(), 'Documents', 'Notes'));
  assert.equal(chooseFolder(['--dir', '~/N'], {}), resolve(homedir(), 'N'));
});
