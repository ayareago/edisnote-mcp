# Edisnote for AI agents

Let Claude Code, Cursor, and other AI tools see the notes and images you save
with [Edisnote](https://chromewebstore.google.com/detail/edisnote/fbnlpkgckonpaekmbfohfobgabbigaan).

Collect references in Chrome, then tell your agent "look at the two images I
just added to my moodboard note". It sees the actual pictures, not just file
names.

- **`/edisnote`**, in the Claude desktop app or the terminal:

  | Type | You get |
  |---|---|
  | `/edisnote` | your recent notes to pick from |
  | `/edisnote moodboard` | that note: its text, source links and newest images |
  | `/edisnote moodboard 2` | the 2 newest images in it |
  | `/edisnote moodboard #3` | image 3 |
  | `/edisnote recent` | what you just saved, from any note |

- **Ask in plain words.** "Check my Edisnote references for the Apex signage"
  works. The agent finds the note and opens the images itself.
- **`@` your notes (terminal).** Type `@` in Claude Code in a terminal and your
  notes show up next to your files.

It only reads. It never changes, moves, or deletes your notes, and nothing
leaves your computer except what your agent sends to its own AI model.

## Before you start

1. **Edisnote saves to a folder.** In the Edisnote panel, click **Sync off** in
   the footer and pick any folder. This finds it on its own: Edisnote leaves a
   small marker in the folder it syncs to, and that's what it looks for.
2. **Node.js 20 or newer** ([nodejs.org](https://nodejs.org)).

## Install

```bash
npx -y edisnote-mcp install
```

That adds it to Claude Code for every project, adds the `/edisnote` command, and prints the config for other
apps. Start a new Claude Code session afterwards.

It finds your Edisnote folder by itself, and follows it if you change folders
in Edisnote later. If you have more than one, it asks which. To name one
yourself:

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

It finds your folder the same way. To name one, add `"--dir", "D:\\My Notes"` to `args`.

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
