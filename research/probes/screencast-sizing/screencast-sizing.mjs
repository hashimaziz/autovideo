/**
 * Probe: does Playwright's recordVideo scale a capture *up* from a smaller viewport,
 * or pad it?
 *
 * The audit asserts it only ever scales down and pads with grey bars. That claim is load-bearing
 * for the `--fast` backend's design, so it is verified here rather than trusted.
 *
 * Run:  node screencast-sizing.mjs
 */
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');

const OUT = new URL('./.out/', import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });

// Magenta page with a small green square in the top-left, so padding (grey bars around a
// centred capture) is distinguishable from page content at both a corner and the centre.
const HTML = `data:text/html,<style>html,body{margin:0;height:100%;background:%23ff00ff}div{position:absolute;top:0;left:0;width:20px;height:20px;background:%2300ff00}</style><div></div>`;

async function probe(viewport, recordSize, label) {
  const dir = `${OUT}${label}/`;
  const context = await chromium.launchPersistentContext(dir + 'profile', {
    headless: true,
    viewport,
    recordVideo: { dir: dir + 'raw', size: recordSize },
    reducedMotion: 'reduce',
    args: ['--hide-scrollbars', '--mute-audio'],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(HTML);
  await page.waitForTimeout(700);

  const saving = page.video().saveAs(dir + 'out.webm');
  await context.close();
  await saving;

  const info = spawnSync(ffmpeg, ['-i', dir + 'out.webm', '-hide_banner'], { encoding: 'utf8' });
  const dims = /Video:.* (\d{2,5})x(\d{2,5})/.exec(info.stderr)?.[0]?.match(/(\d{2,5})x(\d{2,5})/);

  // Pull a frame and sample two pixels: the centre, and a point a quarter of the way in from
  // the left edge. If the capture is padded, the content is a centred box and those points fall
  // outside it — so they read grey rather than the page's magenta.
  const png = dir + 'frame.png';
  spawnSync(ffmpeg, ['-y', '-i', dir + 'out.webm', '-frames:v', '1', '-update', '1', png], { stdio: 'ignore' });
  const raw = spawnSync(ffmpeg, ['-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });

  const w = Number(dims?.[1] ?? 0);
  const h = Number(dims?.[2] ?? 0);
  const at = (x, y) => (w && h ? raw.stdout.subarray((y * w + x) * 3, (y * w + x) * 3 + 3) : null);
  const describe = (px) => (!px ? '?' : px[0] > 200 && px[2] > 200 ? 'magenta(page)' : px.join(','));

  const centre = at(Math.floor(w / 2), Math.floor(h / 2));
  const inset = at(Math.floor(w * 0.25), Math.floor(h / 2));

  const magenta = (px) => Boolean(px && px[0] > 200 && px[2] > 200 && px[1] < 60);

  console.log(
    `${label.padEnd(14)} viewport ${String(viewport.width + 'x' + viewport.height).padEnd(10)}` +
      `capture ${w}x${h}  centre=${describe(centre)}  inset=${describe(inset)}`,
  );
  console.log(
    `  -> ${w > viewport.width ? 'capture is LARGER than the viewport' : w < viewport.width ? 'captured smaller' : 'same size'}` +
      `; ${magenta(inset) ? 'content fills the frame (no padding)' : 'content does NOT reach the frame edges = PADDED'}`,
  );
  return dir;
}

await probe({ width: 540, height: 960 }, { width: 1080, height: 1920 }, 'viewport-half');
await probe({ width: 1080, height: 1920 }, { width: 540, height: 960 }, 'viewport-full');
console.log(`\nWrote ${OUT}`);
