/**
 * Reads an Edisnote folder off disk. Read-only by design: nothing in this
 * package opens a file for writing. The extension's rule is that writers into
 * the notes folder must merge rather than regenerate, and the cheapest way to
 * honour that from a second program is not to be a writer at all.
 *
 * Every path that leaves this module has been checked to sit inside the
 * folder. Note bodies are user content and can name any path in an embed, so
 * `../../secrets.png` must resolve to nothing rather than to a file.
 */

import { readdir, readFile, stat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, sep, posix, dirname, isAbsolute } from 'node:path';
import {
  parseFrontmatter,
  findImageEmbeds,
  findBoardLinks,
  boardItemAddedAt,
  parseCanvas,
  viewableMime,
  extensionOf,
} from './notes.js';

/** Folders that hold Edisnote's own machinery or another app's, never notes. */
const SKIP_DIRS = new Set(['attachments', 'collections', 'node_modules']);

/** Edisnote writes this into every folder it syncs to, and nowhere else. */
export const MARKER = join('.sidenote', 'state.json');

/**
 * Where to look when nobody named a folder, and how deep. Depth 3 under home
 * reaches OneDrive\Documents\Notes, which is where "Documents" really is on
 * many Windows laptops; the OneDrive variables cover one kept outside home.
 */
export function searchRoots(env = process.env, home = homedir()) {
  const roots = [{ dir: home, depth: 3 }];
  for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    if (env[key]) roots.push({ dir: env[key], depth: 3 });
  }
  roots.push({ dir: join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'), depth: 2 });
  return roots;
}

/** Big trees that never hold a notes folder; walking them is only cost. */
const SEARCH_SKIP = new Set(['node_modules', 'AppData', 'Library', 'Application Data']);

/**
 * Every Edisnote folder under `roots`, most recently synced first. A folder
 * counts only if it holds the marker, so a stray "Notes" folder from another
 * app is never picked.
 *
 * Breadth-first, so shallow folders are seen before the visit cap. Links and
 * junctions are not followed (a Dirent for one is not a directory), which
 * keeps the walk inside the roots and out of loops. It only lists names and
 * stats one file per folder; nothing is opened.
 *
 * @returns {Promise<{dir: string, syncedAt: number}[]>}
 */
export async function findFolders(roots = searchRoots(), maxVisits = 4000) {
  const found = new Map();
  let visits = 0;
  for (const { dir, depth } of roots) {
    const queue = [[resolve(dir), 0]];
    while (queue.length && visits < maxVisits) {
      const [abs, level] = queue.shift();
      visits++;
      const marker = await exists(join(abs, MARKER));
      if (marker?.isFile()) {
        const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
        found.set(key, { dir: abs, syncedAt: marker.mtimeMs });
        continue;
      }
      if (level >= depth) continue;
      let entries;
      try {
        entries = await readdir(abs, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || SEARCH_SKIP.has(entry.name)) continue;
        queue.push([join(abs, entry.name), level + 1]);
      }
    }
  }
  return [...found.values()].sort((a, b) => b.syncedAt - a.syncedAt);
}

/**
 * The folder someone named: `--dir` beats `EDISNOTE_DIR`; null when neither
 * was given. A leading `~` is expanded because a JSON config file won't do it
 * for you.
 */
export function chooseFolder(argv = process.argv.slice(2), env = process.env) {
  const i = argv.indexOf('--dir');
  const picked = (i >= 0 && argv[i + 1]) || env.EDISNOTE_DIR;
  return picked ? resolve(picked.replace(/^~(?=$|[\\/])/, homedir())) : null;
}

/**
 * The folder to read. A named one is used as given. Otherwise the most
 * recently synced Edisnote folder found on disk; `found` lists them all so
 * `install` can offer the choice. With none found, `root` is null.
 */
export async function locateFolder(argv = process.argv.slice(2), env = process.env, roots = searchRoots(env)) {
  const named = chooseFolder(argv, env);
  if (named) return { root: named, how: 'named', found: [] };
  const found = await findFolders(roots);
  return { root: found[0]?.dir ?? null, how: found.length ? 'found' : 'none', found };
}

/** True when `abs` is `root` or somewhere beneath it. */
export function isInside(root, abs) {
  const rel = relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function toPosix(rel) {
  return rel.split(sep).join(posix.sep);
}

async function exists(abs) {
  try {
    return await stat(abs);
  } catch {
    return null;
  }
}

/**
 * A symlink inside the folder can still point outside it, so the lexical check
 * is followed by a real-path one before any bytes are read.
 */
async function insideForReal(root, abs) {
  if (!isInside(root, abs)) return false;
  try {
    const [realRoot, realAbs] = await Promise.all([realpath(root), realpath(abs)]);
    return isInside(realRoot, realAbs);
  } catch {
    return false;
  }
}

async function listMarkdown(root, dir = root, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // .sidenote, .obsidian, .trash, .git
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir === root && SKIP_DIRS.has(entry.name)) continue;
      await listMarkdown(root, abs, out);
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Obsidian resolves a bare `![[photo.jpg]]` by searching the vault, and the
 * extension writes paths relative to the folder root. Try the places a target
 * can honestly mean, in that order, and accept only what stays inside.
 */
async function locate(root, noteAbs, target) {
  const tries = [resolve(dirname(noteAbs), target), resolve(root, target)];
  if (!/[\\/]/.test(target)) tries.push(resolve(root, 'attachments', target));
  for (const abs of tries) {
    if (!isInside(root, abs)) continue;
    const info = await exists(abs);
    if (info?.isFile() && (await insideForReal(root, abs))) return { abs, info };
  }
  return null;
}

/**
 * Loads one note's text. Images are not touched here — listing sixty notes
 * should not mean stat-ing three hundred pictures. `imagesOf()` does that on
 * demand.
 */
async function loadNote(root, abs) {
  const [text, info] = await Promise.all([readFile(abs, 'utf8'), stat(abs)]);
  const { data, body } = parseFrontmatter(text);
  const id = toPosix(relative(root, abs)).replace(/\.md$/i, '');
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const sources = Array.isArray(data.sources) ? data.sources : data.sources ? [data.sources] : [];
  const embeds = findImageEmbeds(body);
  return {
    id,
    abs,
    title: (typeof data.title === 'string' && data.title.trim()) || heading || id,
    created: typeof data.created === 'string' ? data.created : null,
    updated: typeof data.updated === 'string' ? data.updated : null,
    mtime: info.mtimeMs,
    sources,
    body,
    embeds,
    boards: findBoardLinks(body),
  };
}

/**
 * Every note in the folder, most recently changed first. The extension only
 * rewrites a .md whose bytes changed, so mtime is a fair "last touched".
 *
 * @returns {Promise<{root: string, found: boolean, notes: Awaited<ReturnType<typeof loadNote>>[]}>}
 */
export async function loadVault(root) {
  const info = root ? await exists(root) : null;
  if (!info?.isDirectory()) return { root, found: false, notes: [] };
  const files = await listMarkdown(root);
  const notes = [];
  for (const abs of files) {
    try {
      notes.push(await loadNote(root, abs));
    } catch {
      // A file deleted between readdir and readFile — the next call sees it gone.
    }
  }
  notes.sort((a, b) => b.mtime - a.mtime);
  return { root, found: true, notes };
}

/**
 * The note's images, numbered in reading order: embeds in the body first, then
 * any board image the note's gallery didn't show (the gallery is a preview and
 * the board can hold more). Numbers are what the tools take, so they must be
 * stable for a given state of the file — they are, being pure reading order.
 *
 * `addedAt` is the best evidence of when each image arrived: the timestamp in
 * a board item's id when there is one, otherwise the file's mtime. Body images
 * are named by position (`slug-03.jpg`), so inserting one mid-note renames the
 * ones after it and refreshes their mtimes — "newest" is therefore a strong
 * hint, not a promise, for body images.
 */
export async function imagesOf(root, note) {
  const images = [];
  const seen = new Set();

  const add = async (target, board) => {
    const hit = await locate(root, note.abs, target);
    const key = hit ? hit.abs : `missing:${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    const rel = hit ? toPosix(relative(root, hit.abs)) : target;
    images.push({
      n: images.length + 1,
      target,
      rel,
      abs: hit?.abs ?? null,
      bytes: hit?.info.size ?? 0,
      ext: extensionOf(rel),
      mime: hit ? viewableMime(rel) : null,
      board,
      addedAt: boardItemAddedAt(rel) ?? hit?.info.mtimeMs ?? null,
    });
  };

  const boards = [];
  const boardTitles = new Map();
  for (const path of note.boards) {
    const hit = await locate(root, note.abs, path);
    if (!hit) continue;
    const canvas = parseCanvas(await readFile(hit.abs, 'utf8'));
    const title = boardTitle(note.body, path);
    boards.push({ path: toPosix(relative(root, hit.abs)), title, ...canvas });
    for (const file of canvas.files) boardTitles.set(file, title);
  }

  for (const embed of note.embeds) {
    if (embed.remote) continue;
    await add(embed.target, boardTitles.get(embed.target) ?? null);
  }
  for (const board of boards) {
    for (const file of board.files) await add(file, board.title);
  }
  return { images, boards };
}

/** The bold label the extension writes before a board link, else its filename. */
function boardTitle(body, path) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const label = new RegExp(`\\*\\*([^*\\n]+)\\*\\*\\s*·\\s*\\[\\[${escaped}`).exec(body)?.[1];
  return label ?? posix.basename(path, '.canvas');
}

/** Reads an image that imagesOf() located. Refuses anything it didn't. */
export async function readImage(root, image) {
  if (!image.abs || !(await insideForReal(root, image.abs))) return null;
  return readFile(image.abs);
}
