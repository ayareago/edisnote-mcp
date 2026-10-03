/**
 * Builds a throwaway Edisnote folder shaped like the one the extension writes:
 * notes at the root, pictures in attachments/, boards in collections/, the
 * extension's own .sidenote/ state directory, plus a secret outside the folder
 * that no path in a note must ever reach.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The smallest valid PNG: one transparent pixel. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

// Item ids carry Date.now() in base 36, as collections.js mints them.
export const EARLY = Date.UTC(2026, 8, 1);
export const LATE = Date.UTC(2026, 9, 2);
const id = (ms, tail) => `it_${ms.toString(36)}_${tail}`;
export const BOARD_EARLY = `attachments/col-refs-${id(EARLY, 'aaaaa')}.png`;
export const BOARD_LATE = `attachments/col-refs-${id(LATE, 'bbbbb')}.png`;
export const BOARD_ONLY = `attachments/col-refs-${id(EARLY + 1000, 'ccccc')}.png`;

export async function makeVault() {
  const base = await mkdtemp(join(tmpdir(), 'edisnote-mcp-'));
  const root = join(base, 'Notes');
  await mkdir(join(root, 'attachments'), { recursive: true });
  await mkdir(join(root, 'collections'), { recursive: true });
  await mkdir(join(root, '.sidenote'), { recursive: true });
  await mkdir(join(root, 'projects'), { recursive: true });

  await writeFile(join(base, 'secret.png'), PNG);
  await writeFile(join(root, '.sidenote', 'state.json'), '{}');

  for (const name of ['food-board-01.png', 'food-board-02.png', 'food-board-03.svg', 'loose.png', 'big.png']) {
    await writeFile(join(root, 'attachments', name), PNG);
  }
  for (const path of [BOARD_EARLY, BOARD_LATE, BOARD_ONLY]) await writeFile(join(root, path), PNG);

  await writeFile(
    join(root, 'food-board.md'),
    [
      '---',
      'title: "Food Board"',
      'created: 2026-09-16',
      'updated: 2026-09-16',
      'sources:',
      '  - "https://www.pinterest.com/pin/1/"',
      '  - "https://example.com/pasta"',
      '---',
      'Warm reds for the menu. ![](attachments/food-board-01.png)',
      '![](attachments/food-board-02.png)![](attachments/food-board-03.svg)',
      '![[loose.png|160]] ![](https://cdn.example.com/remote.jpg)',
      '![](../secret.png) ![[../secret.png]] ![](attachments/gone.png)',
    ].join('\n'),
  );

  await writeFile(
    join(root, 'apex-signage.md'),
    [
      '---',
      'title: Apex Signage',
      '---',
      `**Refs** · [[collections/refs.canvas|open canvas]]`,
      '',
      `![[${BOARD_EARLY}|160]] ![[${BOARD_LATE}|160]]`,
      'Tall monolith, brushed steel.',
    ].join('\n'),
  );
  await writeFile(
    join(root, 'collections', 'refs.canvas'),
    JSON.stringify({
      nodes: [
        { id: 'it_x', type: 'file', file: BOARD_EARLY, x: 0, y: 0, width: 10, height: 10 },
        { id: 'it_y', type: 'file', file: BOARD_LATE, x: 20, y: 0, width: 10, height: 10 },
        { id: 'it_z', type: 'file', file: BOARD_ONLY, x: 0, y: 30, width: 10, height: 10 },
        { id: 'it_t', type: 'text', text: '**Steel Co**\nhttps://steel.example', x: 0, y: 60, width: 10, height: 10 },
        { id: 'mine', type: 'text', text: 'my own Obsidian note', x: 40, y: 60, width: 10, height: 10 },
      ],
    }),
  );

  await writeFile(join(root, 'apex-buffet.md'), '# Apex Buffet\n\nPlates.');
  await writeFile(join(root, 'projects', 'nested.md'), 'No frontmatter here.');
  await writeFile(join(root, 'attachments', 'not-a-note.md'), 'should be skipped');

  return { root, base, cleanup: () => rm(base, { recursive: true, force: true }) };
}
