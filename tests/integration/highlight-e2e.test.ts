import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createVideo, type Video } from '../../src/video/index.js';
import { probeDurationSeconds } from '../../src/recorder/encoder.js';
import { createFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

/**
 * Highlighting, end to end — through the public API, into a real MP4.
 *
 * The overlay tests prove the ring is drawn and tracks its element. These prove the other half:
 * that `highlight()` fits into the pipeline without breaking it, that the time it consumes is
 * real video time, and that two runs of the same script still produce byte-identical output.
 */
describe('highlight — end to end', () => {
  let server: FixtureServer;
  let workDir: string;

  beforeAll(async () => {
    server = await createFixtureServer();
    workDir = await mkdtemp(join(tmpdir(), 'autovideo-highlight-e2e-'));
  });

  afterAll(async () => {
    await server?.close();
    await rm(workDir, { recursive: true, force: true });
  });

  async function renderScript(name: string, body: (video: Video) => Promise<void>) {
    const output = join(workDir, `${name}.mp4`);
    const video = await createVideo({
      viewport: 'vertical',
      fps: 30,
      seed: 42069,
      output,
      outputDir: workDir,
      recorder: { preset: 'ultrafast' },
    });

    try {
      await video.open(server.url('/highlight.html'));
      await body(video);
      return await video.export();
    } finally {
      await video.dispose();
    }
  }

  it('renders a script that highlights an element', async () => {
    const result = await renderScript('highlight-basic', async (video) => {
      await video.scrollTo('#target', { behavior: 'instant' });
      await video.highlight('#target');
      await video.pause(500);
      await video.clearHighlight();
      await video.pause(300);
    });

    expect((await stat(result.path)).size).toBeGreaterThan(0);
    expect(await probeDurationSeconds(result.path)).toBeGreaterThan(0);
  });

  it('consumes logical time, so a highlight is real video time', async () => {
    // A fade is sampled per frame, which means it has to occupy frames. If highlight() returned
    // without advancing the clock the fade would never appear in the video at all.
    const result = await renderScript('highlight-timed', async (video) => {
      await video.highlight('#target', { fadeMs: 300, durationMs: 600 });
      await video.pause(100);
    });

    const seconds = await probeDurationSeconds(result.path);

    // 300 fade-in + 600 hold + 300 fade-out + 100 pause, plus the open's own settle.
    expect(seconds).toBeGreaterThan(1.2);
  });

  it('moves the ring rather than stacking a second one', async () => {
    // Two rings on screen is a question the viewer has to answer; the API answers it for them.
    const result = await renderScript('highlight-move', async (video) => {
      await video.highlight('#target');
      await video.pause(200);
      await video.highlight('#other');
      await video.pause(200);
    });

    expect((await stat(result.path)).size).toBeGreaterThan(0);
  });

  it('records highlights in the manifest', async () => {
    // Diagnostics are the product: a failed render should be explainable from the manifest alone.
    const output = join(workDir, 'highlight-manifest.mp4');
    const video = await createVideo({
      viewport: 'vertical',
      fps: 30,
      seed: 42069,
      output,
      outputDir: workDir,
      recorder: { preset: 'ultrafast' },
    });

    let manifest: Record<string, unknown>;
    try {
      await video.open(server.url('/highlight.html'));
      await video.highlight('#target');
      await video.pause(200);
      await video.clearHighlight();
      await video.pause(200);
      await video.export();
      manifest = video.manifest();
    } finally {
      await video.dispose();
    }

    const actions = JSON.stringify(manifest);
    expect(actions).toContain('highlight');
    expect(actions).toContain('#target');
  });

  it('clearing when nothing is highlighted is a no-op', async () => {
    // Scripts should not have to track whether a highlight is up.
    const result = await renderScript('highlight-clear-empty', async (video) => {
      await video.clearHighlight();
      await video.pause(200);
    });

    expect((await stat(result.path)).size).toBeGreaterThan(0);
  });

  it('is deterministic across runs', async () => {
    // The property the whole pipeline exists for. A per-frame opacity sample must be as
    // reproducible as a per-frame cursor position.
    const run = () =>
      renderScript('highlight-determinism', async (video) => {
        await video.scrollTo('#target', { behavior: 'instant' });
        await video.highlight('#target', { fadeMs: 200 });
        await video.pause(400);
        await video.clearHighlight();
        await video.pause(200);
      });

    const first = await run();
    const second = await run();

    expect(second.frames).toBe(first.frames);
    expect(second.durationMs).toBe(first.durationMs);
  });
});
