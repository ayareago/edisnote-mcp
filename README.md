# Edisnote for AI agents

Let Claude Code, Cursor, and other AI tools see the notes and images you save
with [Edisnote](https://chromewebstore.google.com/detail/edisnote/fbnlpkgckonpaekmbfohfobgabbigaan).

Collect references in Chrome, then tell your agent "look at the two images I
just added to my moodboard note". It sees the actual pictures, not just file
names.

- **`@` your notes.** Type `@` in Claude Code and your notes show up next to
  your files. Pick one and it comes with its text, its source links and its
  newest images.
- **Ask in plain words.** "Check my Edisnote references for the Apex signage"
  works. The agent finds the note and opens the images itself.
- **Shortcuts.** `/edisnote:latest <note>` shows the newest image in a note.
  `/edisnote:recent` shows what you saved most recently, from any note.

It only reads. It never changes, moves, or deletes your notes, and nothing
leaves your computer except what your agent sends to its own AI model.

## Before you start

1. **Edisnote saves to a folder.** In the Edisnote panel, click **Sync off** in
   the footer and pick a folder. `Documents\Notes` is the default this uses.
2. **Node.js 20 or newer** ([nodejs.org](https://nodejs.org)).

## Install

```bash
npx -y edisnote-mcp install
```

That adds it to Claude Code for every project and prints the config for other
apps. Start a new Claude Code session afterwards.

If your notes are somewhere other than `Documents\Notes`:

```bash
npx -y edisnote-mcp install --dir "D:\My Notes"
```

To check what it can see:

```bash
npx -y edisnote-mcp check
```

### Other apps

Add this to the app's MCP settings (Cursor: `~/.cursor/mcp.json`; Claude
Desktop: Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "edisnote": { "command": "npx", "args": ["-y", "edisnote-mcp"] }
  }
}
```

Add `"--dir", "D:\\My Notes"` to `args` if your folder is elsewhere.

## What your agent gets

| | |
|---|---|
| `list_notes` | Find a note. Searches titles, text and the links images came from. |
| `read_note` | A note's text, sources and boards, a numbered list of its images, and the newest ones to look at. |
| `view_images` | Specific images by number, or the newest few. |
| `recent_images` | The newest images across every note. |

Images are numbered in the order they appear in the note. For board images
Edisnote records exactly when each one was added; for images in the note body,
"newest" goes by when the file was last written, which is usually but not
always when you added it.

Images over about 3.7 MB, and formats AI models can't view (SVG, AVIF), are
listed by file path instead of sent.

## Remove it

```bash
claude mcp remove edisnote --scope user
```

## Develop

No dependencies. `npm test` runs the suite with Node's built-in test runner.
