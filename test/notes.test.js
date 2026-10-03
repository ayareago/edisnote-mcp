import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFrontmatter,
  findImageEmbeds,
  findBoardLinks,
  boardItemAddedAt,
  readableBody,
  parseCanvas,
  resolveNote,
  searchNotes,
  viewableMime,
} from '../src/notes.js';

test('frontmatter: the shape the extension writes', () => {
  const { data, body } = parseFrontmatter(
    '---\ntitle: "BYOG - Ayra"\ncreated: 2026-08-17\nsources:\n  - "https://a.example/?q=1&b=2"\n  - https://b.example\n---\nBody here',
  );
  assert.equal(data.title, 'BYOG - Ayra');
  assert.equal(data.created, '2026-08-17');
  assert.deepEqual(data.sources, ['https://a.example/?q=1&b=2', 'https://b.example']);
  assert.equal(body, 'Body here');
});

test('frontmatter: CRLF, BOM, inline lists and single quotes from Obsidian', () => {
  const { data, body } = parseFrontmatter("﻿---\r\ntitle: 'It''s here'\r\ntags: [a, \"b\"]\r\n---\r\nText");
  assert.equal(data.title, "It's here");
  assert.deepEqual(data.tags, ['a', 'b']);
  assert.equal(body, 'Text');
});

test('frontmatter: none at all leaves the body whole', () => {
  assert.deepEqual(parseFrontmatter('# Hi\n---\nnot frontmatter'), { data: {}, body: '# Hi\n---\nnot frontmatter' });
});

test('embeds: Markdown and wiki forms in reading order, non-images skipped', () => {
  const body = 'a ![](attachments/x-01.jpg) b ![[y.webp|160]] ![[other-note]] ![[board.canvas]] ![alt](<with space.png> "t") ![](https://c.example/z.png)';
  const found = findImageEmbeds(body).map((e) => [e.target, e.remote]);
  assert.deepEqual(found, [
    ['attachments/x-01.jpg', false],
    ['y.webp', false],
    ['with space.png', false],
    ['https://c.example/z.png', true],
  ]);
});

test('embeds: percent-encoded Markdown paths decode, wiki paths do not', () => {
  const [md, wiki] = findImageEmbeds('![](my%20pic.png) ![[100%25.png]]');
  assert.equal(md.target, 'my pic.png');
  assert.equal(wiki.target, '100%25.png');
});

test('board links: both the current and the old form, each once', () => {
  assert.deepEqual(findBoardLinks('**R** · [[collections/r.canvas|open canvas]] ![[collections/r.canvas]] ![[collections/s.canvas]]'), [
    'collections/r.canvas',
    'collections/s.canvas',
  ]);
});

test('board item time comes from the id, and only from a real id', () => {
  const ms = Date.UTC(2026, 8, 7, 23, 18, 52, 299);
  assert.equal(boardItemAddedAt(`attachments/col-ideas-it_${ms.toString(36)}_ijn5d.jpg`), ms);
  assert.equal(boardItemAddedAt('attachments/ideas-03.jpg'), null);
  assert.equal(boardItemAddedAt('attachments/col-x-it_zz_abc.jpg'), null); // decodes to 1295 ms
});

test('readable body numbers images and drops board links', () => {
  const body = '**Refs** · [[collections/r.canvas|open canvas]]\n\n![](a.png) text ![](b.png) ![](gone.png) ![](https://w.example/i.jpg)';
  const embeds = findImageEmbeds(body);
  const numbers = new Map([['a.png', 1], ['b.png', 2]]);
  assert.equal(
    readableBody(body, embeds, (t) => numbers.get(t)),
    '[image 1] text [image 2] [missing image: gone.png] [web image: https://w.example/i.jpg]',
  );
});

test('canvas: images in board order, text cards kept, junk tolerated', () => {
  const json = JSON.stringify({
    nodes: [
      { type: 'file', file: 'b.png', x: 100, y: 0 },
      { type: 'file', file: 'a.png', x: 0, y: 0 },
      { type: 'file', file: 'c.png', x: 0, y: 50 },
      { type: 'file', file: 'doc.pdf', x: 0, y: 60 },
      { type: 'text', text: '  hello  ', x: 0, y: 70 },
      { type: 'link', url: 'https://x' },
    ],
  });
  assert.deepEqual(parseCanvas(json), { files: ['a.png', 'b.png', 'c.png'], texts: ['hello'] });
  assert.deepEqual(parseCanvas('{not json'), { files: [], texts: [] });
});

test('only formats Claude can view are sent inline', () => {
  assert.equal(viewableMime('a.JPG'), 'image/jpeg');
  assert.equal(viewableMime('a.webp'), 'image/webp');
  assert.equal(viewableMime('a.svg'), null);
});

const notes = [
  { id: 'apex-signage', title: 'Apex Signage', mtime: 3, body: '', sources: [] },
  { id: 'apex-buffet', title: 'Buffet  Apex', mtime: 2, body: 'plates', sources: [] },
  { id: 'food-board', title: 'Food Board', mtime: 1, body: 'warm reds', sources: ['https://pinterest.com/pin/1'] },
];

test('resolve: exact id or title wins, loose words narrow, ties ask', () => {
  assert.equal(resolveNote(notes, 'food-board').note.id, 'food-board');
  assert.equal(resolveNote(notes, 'FOOD BOARD').note.id, 'food-board');
  assert.equal(resolveNote(notes, 'buffet').note.id, 'apex-buffet');
  const { note, candidates } = resolveNote(notes, 'apex');
  assert.equal(note, undefined);
  assert.deepEqual(candidates.map((n) => n.id), ['apex-signage', 'apex-buffet']);
  assert.deepEqual(resolveNote(notes, 'nothing like it').candidates, []);
  assert.deepEqual(resolveNote(notes, '  ').candidates, []);
});

test('search: title beats body beats nothing; every word must hit', () => {
  assert.deepEqual(searchNotes(notes, 'apex').map((n) => n.id), ['apex-signage', 'apex-buffet']);
  assert.deepEqual(searchNotes(notes, 'pinterest').map((n) => n.id), ['food-board']);
  assert.deepEqual(searchNotes(notes, 'apex reds'), []);
});
