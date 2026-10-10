/**
 * Empirical probe: does Playwright's `recordVideo` screencast render the mouse cursor?
 *
 * Why this exists
 * ---------------
 * The architecture audit's load-bearing claim is that a screencast-based recorder cannot draw
 * a cursor, and therefore cannot support this framework's first-class cursor requirement.
 * That claim is verified here rather than taken on faith.
 *
 * What it does
 * ------------
 * 1. Serves `page.html` over real HTTP (a `data:` URL loads but records blank — see the
 *    git history of this file for that dead end).
 * 2. Launches Chromium with `recordVideo` enabled at 540x960.
 * 3. Sweeps the mouse across the `TARGET` box in 25 discrete moves, so any captured cursor
 *    must be somewhere over drawn content.
 * 4. Saves the WebM and extracts individual frames for visual inspection.
 *
 * Run:  node screencast-cursor.mjs
 * Look: open frame-*.png — the page renders, the mouse is demonstrably on-screen, and
 *       no cursor is drawn.
 */

import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '.out');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

/** ffmpeg ships as a dependency of this repo; no system install required. */
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static');

const server = createServer((_, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(readFileSync(join(here, 'page.html')));
}).listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const url = `http://localhost:${server.address().port}/`;

const context = await chromium.launchPersistentContext(join(out, 'profile'), {
  headless: true,
  viewport: { width: 540, height: 960 },
  recordVideo: { dir: join(out, 'raw'), size: { width: 540, height: 960 } },
  reducedMotion: 'reduce',
  args: ['--hide-scrollbars', '--mute-audio'],
});

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(1000);

// Sweep across TARGET (120,180)-(340,270) so the pointer must be over drawn content.
for (let i = 0; i <= 24; i++) {
  await page.mouse.move(120 + i * 8, 220 + i * 7);
  await page.waitForTimeout(30);
}
await page.mouse.down();
await page.waitForTimeout(100);
await page.mouse.up();
await page.waitForTimeout(500);

// saveAs resolves only once the capture finishes, and the capture finishes when the
// context closes. Start it, close, then await — awaiting before close deadlocks.
const saving = page.video().saveAs(join(out, 'capture.webm'));
await context.close();
await saving;
server.close();

const capture = join(out, 'capture.webm');
const probe = spawnSync(ffmpeg, ['-i', capture, '-hide_banner', '-f', 'null', '-'], { encoding: 'utf8' });
console.log((probe.stderr.match(/Duration:.*|Stream #0:0.*/) ?? []).join('\n'));

for (const frameNumber of [30, 40, 50]) {
  spawnSync(
    ffmpeg,
    ['-y', '-i', capture, '-vf', `select=eq(n\\,${frameNumber})`, '-frames:v', '1', '-update', '1',
     join(out, `frame-${frameNumber}.png`)],
    { stdio: 'ignore' },
  );
}

console.log(`\nWrote ${out}. Inspect frame-40.png — the TARGET box is on screen and the mouse`);
console.log('was swept across it. Look for a cursor; there is not one.');