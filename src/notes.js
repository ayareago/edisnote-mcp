/**
 * Pure parsing for an Edisnote folder: frontmatter, image embeds, board links,
 * note lookup. No file system here — vault.js reads the bytes and hands them
 * in, which is what lets the tests run on strings.
 *
 * The format being parsed is what the extension's markdown.js and vault.js
 * write, plus whatever the user has since done to those files in Obsidian. So
 * every parser here accepts both the Markdown form `![](path)` the extension
 * writes and the wiki form `![[path|160]]` Obsidian writes.
 */

/** Formats a model can actually look at. Everything else is listed by path. */
const VIEWABLE = new Map([
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
]);

const IMAGE_EXTENSIONS = new Set([...VIEWABLE.keys(), 'svg', 'avif', 'bmp', 'heic', 'tif', 'tiff']);

export function extensionOf(path) {
  const match = /\.([A-Za-z0-9]+)$/.exec(path);
  return match ? match[1].toLowerCase() : '';
}

export function isImagePath(path) {
  return IMAGE_EXTENSIONS.has(extensionOf(path));
}

/** The MIME type to send an image inline with, or null when it can't be. */
export function viewableMime(path) {
  return VIEWABLE.get(extensionOf(path)) ?? null;
}

/**
 * Splits a leading `---` block off the note. Only the subset of YAML that the
 * extension writes, and that Obsidian's property editor writes back, is
 * understood: scalars, quoted scalars, block lists and inline `[a, b]` lists.
 * Anything stranger is kept as its raw string rather than guessed at.
 *
 * @returns {{data: Record<string, string|string[]>, body: string}}
 */
export function parseFrontmatter(text) {
  const normalised = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalised);
  if (!match) return { data: {}, body: normalised };

  const data = {};
  let listKey = null;
  for (const line of match[1].split('\n')) {
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (item && listKey) {
      data[listKey].push(unquote(item[1]));
      continue;
    }
    const pair = /^([A-Za-z0-9_][\w -]*?)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, raw] = pair;
    if (raw === '') {
      data[key] = [];
      listKey = key;
    } else if (/^\[.*\]$/.test(raw)) {
      data[key] = raw.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean);
      listKey = null;
    } else {
      data[key] = unquote(raw);
      listKey = null;
    }
  }
  return { data, body: normalised.slice(match[0].length) };
}

function unquote(value) {
  const v = value.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

/** Images, in reading order. Group 1/2 = Markdown form, group 3 = wiki form. */
const EMBED = /!\[[^\]]*\]\((?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\)|!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

/**
 * Every image embed in the body, in the order a reader meets them. Embeds of
 * other things (notes, canvases, PDFs) are skipped; remote URLs are kept and
 * flagged so they can be listed without being fetched.
 *
 * @returns {Array<{target: string, remote: boolean, wiki: boolean, start: number, end: number}>}
 */
export function findImageEmbeds(body) {
  const found = [];
  for (const match of body.matchAll(EMBED)) {
    const wiki = match[3] !== undefined;
    let target = (match[1] ?? match[2] ?? match[3]).trim();
    if (!wiki) target = safeDecode(target);
    const remote = /^https?:\/\//i.test(target);
    if (!remote && !isImagePath(target)) continue;
    found.push({ target, remote, wiki, start: match.index, end: match.index + match[0].length });
  }
  return found;
}

function safeDecode(value) {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

/**
 * The boards (collections) a note shows. The extension writes
 * `[[collections/x.canvas|open canvas]]` above the gallery; an older version
 * wrote `![[collections/x.canvas]]`. Both count, each board once.
 */
export function findBoardLinks(body) {
  const boards = [];
  for (const match of body.matchAll(/!?\[\[([^\]|#]+\.canvas)(?:\|[^\]]*)?\]\]/g)) {
    const path = match[1].trim();
    if (!boards.includes(path)) boards.push(path);
  }
  return boards;
}

/**
 * Board images are named `col-<slug>-it_<base36 ms>_<random>.<ext>`: the item
 * id is minted from Date.now() in collections.js, so the file name carries the
 * exact moment the image was added. That is better evidence than any mtime.
 */
export function boardItemAddedAt(path) {
  const match = /(?:^|\/)col-.+-it_([0-9a-z]+)_[0-9a-z]+\.[A-Za-z0-9]+$/.exec(path);
  if (!match) return null;
  const ms = parseInt(match[1], 36);
  // Anything outside 2020–2100 is a coincidental match, not a timestamp.
  return ms > 1577836800000 && ms < 4102444800000 ? ms : null;
}

/**
 * Replaces each image embed with `[image N]` so the text Claude reads lines up
 * with the numbers the image tools take, and drops board links, which are
 * summarised separately. `numberFor` maps an embed's target to its number.
 */
export function readableBody(body, embeds, numberFor) {
  let out = '';
  let last = 0;
  for (const embed of embeds) {
    out += body.slice(last, embed.start);
    const n = numberFor(embed.target);
    out += embed.remote ? `[web image: ${embed.target}]` : n ? `[image ${n}]` : `[missing image: ${embed.target}]`;
    last = embed.end;
  }
  out += body.slice(last);
  return out
    .replace(/\*\*[^*\n]+\*\*\s*·\s*\[\[[^\]]+\.canvas(?:\|[^\]]*)?\]\]/g, '')
    .replace(/!?\[\[[^\]]+\.canvas(?:\|[^\]]*)?\]\]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Pulls what a model needs out of a JSON Canvas file: the image files in the
 * order they sit on the board (top to bottom, then left to right) and the text
 * cards. Edisnote's own link cards are text nodes, so links arrive here too.
 */
export function parseCanvas(json) {
  let doc;
  try {
    doc = JSON.parse(json);
  } catch {
    return { files: [], texts: [] };
  }
  const nodes = Array.isArray(doc?.nodes) ? doc.nodes : [];
  const placed = [...nodes].sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));
  return {
    files: placed.filter((n) => n.type === 'file' && typeof n.file === 'string' && isImagePath(n.file)).map((n) => n.file),
    texts: placed.filter((n) => n.type === 'text' && typeof n.text === 'string' && n.text.trim()).map((n) => n.text.trim()),
  };
}

export function normalise(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Finds the note a person or a model meant. Exact id or title wins outright;
 * otherwise every word of the query has to appear in the id or title. More
 * than one hit is returned as candidates rather than silently picking one —
 * looking at the wrong moodboard is worse than asking.
 *
 * @template {{id: string, title: string, mtime: number}} N
 * @param {N[]} notes
 * @returns {{note?: N, candidates: N[]}}
 */
export function resolveNote(notes, query) {
  const q = normalise(query);
  if (!q) return { candidates: [] };

  const byRecency = (list) => [...list].sort((a, b) => b.mtime - a.mtime);
  const exact = notes.filter((n) => normalise(n.id) === q || normalise(n.title) === q);
  if (exact.length === 1) return { note: exact[0], candidates: [] };
  if (exact.length > 1) return { candidates: byRecency(exact) };

  const words = q.split(' ');
  const hits = notes.filter((n) => {
    const hay = `${normalise(n.id)} ${normalise(n.title)}`;
    return words.every((w) => hay.includes(w));
  });
  if (hits.length === 1) return { note: hits[0], candidates: [] };
  return { candidates: byRecency(hits) };
}

/** Case-insensitive search over title, id, body and sources, best first. */
export function searchNotes(notes, query) {
  const words = normalise(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  const scored = [];
  for (const note of notes) {
    const head = `${normalise(note.title)} ${normalise(note.id)}`;
    const rest = `${normalise(note.body)} ${normalise((note.sources ?? []).join(' '))}`;
    let score = 0;
    for (const w of words) {
      if (head.includes(w)) score += 3;
      else if (rest.includes(w)) score += 1;
      else {
        score = 0;
        break;
      }
    }
    if (score) scored.push({ note, score });
  }
  return scored.sort((a, b) => b.score - a.score || b.note.mtime - a.note.mtime).map((s) => s.note);
}
