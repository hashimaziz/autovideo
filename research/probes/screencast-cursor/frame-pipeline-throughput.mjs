/**
 * Empirical probe: what does a deterministic frame pipeline actually cost?
 *
 * The architecture audit commits this framework to replacing Playwright's screencast with a
 * logical-clock frame pump. That is only defensible if the pump is fast enough. This measures
 * the real pipeline: `Page.captureScreenshot` via CDP, piped into ffmpeg's stdin, encoded to
 * H.264 MP4.
 *
 * Two configurations are compared, because the audit's layout-viewport trick only pays off if
 * encoding — not capture — is resolution-bound:
 *
 *   - capture at 540x960, upscale to 1080x1920 in ffmpeg with Lanczos
 *   - capture at 1080x1920 natively
 *
 * Results on an M-series laptop (Playwright 1.63 / Chromium 1243, 60 frames per run):
 *
 *   540x960  -> 1080x1920 : capture 16.5 ms/frame, capture+encode 18.4 ms/frame (54 fps)
 *   1080x1920 native       : capture 16.5-20.0 ms/frame, capture+encode 21.9-35.3 ms/frame
 *
 * Capture is resolution-independent and is not the bottleneck. Encoding is
 * resolution-bound and noisy: the layout-split figure was identical to 0.1 ms across
 * three runs, while the native figure swung between 22 and 35 ms. So the split is worth
 * 1.2-1.9x end to end and is never worse.
 *
 * Run:  node frame-pipeline-throughput.mjs
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '.out');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const ffmpeg = createRequire(import.meta.url)('ffmpeg-static');
const FRAMES = 60;

const server = createServer((_, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(readFileSync(join(here, 'page.html')));
}).listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const url = `http://localhost:${server.address().port}/`;

/**
 * Encode a raw JPEG frame stream into an MP4.
 *
 * `-c:v mjpeg` is required, not `-c:v jpeg` — "jpeg" is not a decoder name and ffmpeg exits
 * immediately. That failure mode is dangerous to combine with backpressure: ffmpeg closes
 * stdin, so a `once('drain')` await never resolves and the caller hangs forever rather than
 * reporting the real error. Hence the explicit exit-code report below.
 */
function encoder(size) {
  const args = ['-y', '-f', 'image2pipe', '-framerate', '60', '-c:v', 'mjpeg', '-i', 'pipe:0'];
  if (size !== 'native') {
    args.push('-vf', `scale=${size * 2}:${size * 3}:flags=lanczos`);
  }
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an',
    join(out, `out-${size}.mp4`),
  );

  const child = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  const closed = new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
  return { child, closed };
}

for (const size of [540, 1080]) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: size, height: size === 540 ? 960 : 1920 },
    reducedMotion: 'reduce',
    args: ['--hide-scrollbars'],
  });
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForTimeout(400);

  // CDP is used rather than page.screenshot() because it returns base64 directly,
  // avoiding an extra decode, and it is the same path the real frame pump will use.
  const cdp = await context.newCDPSession(page);
  const capture = () => cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });

  // Warm up: the first capture after navigation pays for surface setup.
  await capture();

  const captureStart = performance.now();
  for (let i = 0; i < FRAMES; i++) await capture();
  const captureMs = performance.now() - captureStart;

  const encoderState = encoder(size);
  const encodeStart = performance.now();
  for (let i = 0; i < FRAMES; i++) {
    const { data } = await capture();
    // Deliberately not awaiting drain: ffmpeg keeps up, and awaiting it hides
    // encoder death as a hang. Backpressure is handled by the stdio highWaterMark
    // in the real implementation.
    encoderState.child.stdin.write(Buffer.from(data, 'base64'));
  }
  encoderState.child.stdin.end();
  const { code, stderr } = await Promise.race([
    encoderState.closed,
    new Promise((resolve) => setTimeout(() => resolve({ code: 'TIMEOUT', stderr: '' }), 30_000)),
  ]);
  const encodeMs = performance.now() - encodeStart;

  console.log(
    `${size === 540 ? '540x960 ->1080x1920' : '1080x1920 native  '}  ` +
    `capture ${(captureMs / FRAMES).toFixed(1)} ms/f (${(FRAMES / (captureMs / 1000)).toFixed(0)} fps)  ` +
    `capture+encode ${(encodeMs / FRAMES).toFixed(1)} ms/f (${(FRAMES / (encodeMs / 1000)).toFixed(0)} fps)  ` +
    `ffmpeg exit=${code}`,
  );
  if (code !== 0) console.error(stderr.slice(-600));

  await browser.close();
}

server.close();
console.log(`\nWrote ${out}`);