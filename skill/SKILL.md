---
name: edisnote
description: Look at the user's Edisnote notes and the images they saved in Chrome. Use when the user types /edisnote, mentions Edisnote, or says "my notes", "my references", "the images I saved", "what I just added", or names one of their notes.
argument-hint: "[note] [N newest | #image] — or recent"
allowed-tools: mcp__edisnote__list_notes mcp__edisnote__read_note mcp__edisnote__view_images mcp__edisnote__recent_images
---

<!-- edisnote-mcp skill: the installer may overwrite this file. -->

The user collects references with Edisnote, a Chrome side-panel notepad. Every
note is a Markdown file with images, and the `edisnote` MCP server reads them.
Use its tools; don't search the disk yourself.

What they asked for: `$ARGUMENTS`

Work out which case this is, then act. Don't explain these steps to the user.

1. **Nothing given** (the line above is empty): call `list_notes` with
   `limit: 8`. Then ask which note with AskUserQuestion: header `Note`, the
   **four most recently changed notes** as options, each label the note's title
   (shortened to a few words if long), each description its image count and
   when it changed. The automatic "Other" option lets them type any name. Then
   read the chosen note as in case 3.

2. **`recent`, `new`, `latest`, or "what I just saved", with no note named**:
   call `recent_images`, with `count` if they gave a number.

3. **A note name alone** (any part of the title works): call `read_note`.

4. **A note plus one bare number**, e.g. `independence party 2`, or with
   "newest/latest/last N": that is always the **newest N**, never image number
   N. Call `view_images` with `newest: N`.

5. **A note plus specific images**, written `#3`, `image 3`, `images 3 and 5`,
   or a list like `3,5`: call `view_images` with `numbers`.

If a tool says the name matches several notes, ask which one with
AskUserQuestion, using those candidates as the options. Never guess.

After the images arrive, describe what's in each one in a line or two:
subject, colour, type, layout. Then stop, unless they asked for more. Keep the
note in mind for the rest of the conversation, so that "the second one" or
"what did I add after that" work without naming it again.

If the `edisnote` tools aren't available at all, tell the user to run
`npx -y edisnote-mcp install` in a terminal and then start a new session.
