/**
 * Claude desktop app support for `install`. The app's chat (the part free
 * users have) reads local MCP servers from claude_desktop_config.json, a
 * different file from Claude Code's. Without this step free users get nothing:
 * `claude mcp add` needs Claude Code, which needs a paid plan.
 *
 * Where the file lives depends on the install:
 *   Mac                        ~/Library/Application Support/Claude/
 *   Windows, classic installer %APPDATA%\Claude\
 *   Windows, Store (MSIX)      %LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\
 *   Windows, newer builds      %LOCALAPPDATA%\Claude-Data\<id>\  (the app leaves a
 *                              `.user-data-left.<id>` marker in %APPDATA%\Claude)
 * The last one was found on a real Windows 11 install on 2026-11-06.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'claude_desktop_config.json';
const MARKER = '.user-data-left.';

/**
 * Config files to write. Every existing config is a real install, so all of
 * them get the server. With none yet but the app's folder present (installed,
 * never opened Settings > Developer), the one the app would create.
 *
 * @returns {string[]} absolute file paths; empty when the app isn't installed
 */
export function desktopConfigFiles({ platform = process.platform, env = process.env, home, fs = { existsSync, readdirSync } } = {}) {
  const has = (p) => fs.existsSync(p);
  const list = (dir) => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  };

  if (platform === 'darwin') {
    const dir = join(home, 'Library', 'Application Support', 'Claude');
    return has(dir) ? [join(dir, FILE)] : [];
  }
  if (platform !== 'win32') return [];

  const roaming = env.APPDATA || join(home, 'AppData', 'Roaming');
  const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const classic = join(roaming, 'Claude');
  const dataRoot = join(local, 'Claude-Data');

  const moved = list(classic).filter((f) => f.startsWith(MARKER)).map((f) => join(dataRoot, f.slice(MARKER.length)));
  const dataDirs = list(dataRoot).map((d) => join(dataRoot, d));
  const storeDirs = list(join(local, 'Packages'))
    .filter((p) => /^Claude_/i.test(p))
    .map((p) => join(local, 'Packages', p, 'LocalCache', 'Roaming', 'Claude'));

  const found = [];
  const add = (dir) => {
    const file = join(dir, FILE);
    if (!found.some((f) => f.toLowerCase() === file.toLowerCase())) found.push(file);
  };
  for (const dir of [...moved, ...dataDirs, ...storeDirs, classic]) if (has(join(dir, FILE))) add(dir);
  if (found.length) return found;

  // No config file anywhere yet: create it where this install keeps its data.
  const movedDir = moved.find(has);
  if (movedDir) return [join(movedDir, FILE)];
  if (has(classic)) return [join(classic, FILE)];
  return [];
}

/**
 * Adds `mcpServers.<name>` to the text of a claude_desktop_config.json. Other
 * keys and servers are kept; an existing entry of that name is left alone, as
 * it may be the user's own. A file that isn't valid JSON is never rewritten.
 *
 * @returns {{status: 'added' | 'exists' | 'invalid', text: string}}
 */
export function addDesktopServer(raw, name, entry) {
  let config = {};
  if (raw.trim()) {
    try {
      config = JSON.parse(raw);
    } catch {
      return { status: 'invalid', text: raw };
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) return { status: 'invalid', text: raw };
  }
  const servers = config.mcpServers ?? {};
  if (typeof servers !== 'object' || Array.isArray(servers)) return { status: 'invalid', text: raw };
  if (Object.hasOwn(servers, name)) return { status: 'exists', text: raw };
  config.mcpServers = { ...servers, [name]: entry };
  return { status: 'added', text: `${JSON.stringify(config, null, 2)}\n` };
}
