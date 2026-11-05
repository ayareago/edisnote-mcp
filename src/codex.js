/**
 * Codex support for `install`. The Codex CLI, its IDE extension and the
 * ChatGPT/Codex desktop app all read local MCP servers from one file,
 * ~/.codex/config.toml (or $CODEX_HOME/config.toml), on Windows and Mac.
 *
 * The installer writes that file itself rather than calling `codex mcp add`:
 * desktop-app users have no `codex` on PATH, and the add command can't set the
 * start timeout. Same approach as the Figma bridge setup, which was tested
 * against the real app.
 */

import { join, dirname } from 'node:path';

/** Where Codex keeps its config. */
export function codexHome(env, home) {
  return env.CODEX_HOME || join(home, '.codex');
}

/**
 * The server entry for Codex, from the same launch command Claude Code gets.
 *
 * Windows: Codex starts servers without a shell, so `npx` (really npx.cmd)
 * isn't found; `cmd /c npx` is. Mac: an app opened from the Dock doesn't get
 * the terminal's PATH, so a Node from nvm or Homebrew is invisible; the full
 * path to npx next to this Node, plus a PATH that includes it, fixes that.
 */
export function codexEntry(launch, { platform = process.platform, execPath = process.execPath } = {}) {
  const [cmd, ...args] = launch;
  if (cmd === 'node') return { command: execPath, args };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', cmd, ...args] };
  const bin = dirname(execPath);
  const path = [bin, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].join(':');
  return { command: join(bin, cmd), args, env: { PATH: path } };
}

/**
 * Adds a `[mcp_servers.<name>]` table to the text of a config.toml. Appending
 * a new table leaves everything else in the file exactly as it was. An
 * existing table of that name is left alone: it may be the user's own.
 *
 * @returns {{status: 'added' | 'exists', text: string}}
 */
export function addCodexServer(raw, name, entry) {
  const table = new RegExp(`^\\s*\\[mcp_servers\\.("?)${name}\\1\\]`, 'm');
  if (table.test(raw)) return { status: 'exists', text: raw };
  return { status: 'added', text: (raw && !raw.endsWith('\n') ? `${raw}\n` : raw) + codexBlock(name, entry, raw ? '\n' : '') };
}

/** The TOML for one server. JSON strings are valid TOML basic strings. */
export function codexBlock(name, entry, lead = '') {
  const s = JSON.stringify;
  let block = `${lead}# Added by edisnote-mcp install\n[mcp_servers.${name}]\n`;
  block += `command = ${s(entry.command)}\n`;
  block += `args = [${entry.args.map((a) => s(a)).join(', ')}]\n`;
  // Codex waits 10 s by default; a first npx download takes longer.
  block += 'startup_timeout_sec = 60\n';
  if (entry.env) {
    block += `\n[mcp_servers.${name}.env]\n`;
    for (const [k, v] of Object.entries(entry.env)) block += `${k} = ${s(v)}\n`;
  }
  return block;
}
