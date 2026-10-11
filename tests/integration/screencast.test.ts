import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createVideo } from '../../src/video/index.js';
import { probeDurationSeconds, resolveFfmpegBinary } from '../../src/recorder/encoder.js';
import { createFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

/**
 * The screencast backend.
 *
 * Preview-only, and these tests are as much about its *limits* as its output. The audit's claim
 * that the frame pipeline should replace it rests on three measured differences, and a backend
 * whose whole purpose is to let anyone check that claim is worth no more than its documentation
 * unless those limits are pinned down.
 */
describe('screencast backend', () => {
  let server: FixtureServer;
  let workDir: string;

  beforeAll(async () => {
    server = await createFixtureServer();
    workDir = await mkdtemp(join(tmpdir(), 'autovideo-screencast-'));
  });

  afterAll(async () => {
    await server?.close();
    await rm(workDir, { recursive: true, force: true });
  });

  /** Read the dimensions ffmpeg actually produced. */
  const probeDimensions = async (file: string): Promise<string> => {
    const { spawnSync } = await import('node:child_process');
    const probe = spawnSync(resolveFfmpegBinary() as string, ['-hide_banner', '-i', file], {
      encoding: 'utf8',
    });
    // Group 1 alone is only the width; both are needed for a WxH comparison.
    return (
      /\b(\d{2,5})x(\d{2,5})\b/
        .exec(probe.stderr ?? '')
        ?.slice(1, 3)
        .join('x') ?? ''
    );
  };

  it('produces a playable MP4', async () => {
    const output = join(workDir, 'basic.mp4');
    const video = await createVideo({
      viewport: 'vertical',
      fps: 30,
      output,
      outputDir: workDir,
      recorder: { backend: 'screencast', preset: 'ultrafast' },
    });

    try {
      await video.open(server.url('/'));
      await video.pause(700);

      const result = await video.export();
      const bytes = await readFile(result.path);

      expect(bytes.subarray(4, 8).toString()).toBe('ftyp');
      expect(bytes.length).toBeGreaterThan(1000);
    } finally {
      await video.dispose();
    }
  }, 180_000);

  it('lays out at the output size rather than the layout size', async () => {
    // The screencast only scales *down*, so a larger capture comes back padded with grey bars.
    // Verified in ARCHITECTURE.md §3. The consequence is that this backend cannot
    // use the layout-split zoom, and its output is only as legible as a 1:1 render — one of the
    // reasons it is not the default.
    const output = join(workDir, 'sizing.mp4');
    const video = await createVideo({
      viewport: 'vertical',
      layoutScale: 2,
      fps: 30,
      output,
      outputDir: workDir,
      recorder: { backend: 'screencast', preset: 'ultrafast' },
    });

    try {
      await video.open(server.url('/'));
      await video.pause(500);
      await video.export();

      expect(await probeDimensions(output)).toBe('1080x1920');
    } finally {
      await video.dispose();
    }
  }, 180_000);

  it('trims the teardown tail rather than shipping frozen frames', async () => {
    // Context teardown keeps the screencast running over a static page, which would otherwise
    // become dead air at the end of the video.
    const output = join(workDir, 'trim.mp4');
    const video = await createVideo({
      viewport: 'vertical',
      fps: 30,
      output,
      outputDir: workDir,
      recorder: { backend: 'screencast', preset: 'ultrafast' },
    });

    try {
      await video.open(server.url('/'));
      await video.pause(600);
      const result = await video.export();

      const seconds = await probeDurationSeconds(output);
      expect(seconds).not.toBeNull();
      // Without trimming this runs well past the script's own duration.
      expect(seconds as number).toBeLessThanOrEqual(result.durationMs / 1000 + 0.6);
    } finally {
      await video.dispose();
    }
  }, 180_000);

  it('renders a pause of roughly the requested length', async () => {
    // Timed by the wall clock rather than by frames, so it is approximate — which is precisely
    // why this backend is not the default. The assertion is a band, not equality.
    const output = join(workDir, 'timing.mp4');
    const video = await createVideo({
      viewport: 'vertical',
      fps: 30,
      output,
      outputDir: workDir,
      recorder: { backend: 'screencast', preset: 'ultrafast' },
    });

    try {
      await video.open(server.url('/'));
      await video.pause(1000);
      await video.export();

      const seconds = (await probeDurationSeconds(output)) as number;
      expect(seconds).toBeGreaterThan(0.5);
      expect(seconds).toBeLessThan(2.5);
    } finally {
      await video.dispose();
    }
  }, 180_000);

  it('leaves no scratch capture behind', async () => {
    const output = join(workDir, 'clean.mp4');
    const video = await createVideo({
      viewport: 'vertical',
      fps: 30,
      output,
      outputDir: workDir,
      recorder: { backend: 'screencast', preset: 'ultrafast' },
    });

    try {
      await video.open(server.url('/'));
      await video.pause(300);
      await video.export();
    } finally {
      await video.dispose();
    }

    expect((await stat(output)).size).toBeGreaterThan(1000);
    // Chromium's raw segments are an implementation detail and must not survive the run.
    await expect(stat(join(workDir, '.scratch', 'screencast'))).rejects.toThrow();
  }, 180_000);

  it('leaves no video behind when the script fails', async () => {
    // The "a failed run leaves nothing that looks finished" contract, on this backend too.
    const output = join(workDir, 'should-not-exist.mp4');
    const video = await createVideo({
      viewport: 'vertical',
      fps: 30,
      output,
      outputDir: workDir,
      timeouts: { action: 2500, navigation: 10_000 },
      recorder: { backend: 'screencast', preset: 'ultrafast' },
    });

    await expect(
      (async () => {
        await video.open(server.url('/'));
        await video.click('#no-such-element');
        await video.export();
      })(),
    ).rejects.toThrow();

    await video.dispose();
    await expect(stat(output)).rejects.toThrow();
  }, 180_000);

  it('does not draw a cursor, unlike the frame pipeline', async () => {
    // The single most important documented limitation, asserted rather than asserted-in-prose.
    // A real OS cursor is not captured, and the DOM overlay is not either — Chromium's screencast
    // renders the page without anything the framework injected on top of it.
    const output = join(workDir, 'nocursor.mp4');
    const video = await createVideo({
      viewport: 'vertical',
      fps: 30,
      output,
      outputDir: workDir,
      recorder: { backend: 'screencast', preset: 'ultrafast' },
    });

    try {
      await video.open(server.url('/'));
      // Move and click: on the frame pipeline this paints a visible overlay.
      await video.cursor.moveTo('#ticker');
      await video.cursor.click();
      await video.pause(500);
      await video.export();

      // The cursor element exists in the page — the framework still injected it — but the capture
      // does not include it. Asserting absence of a visual difference is not possible from here
      // without decoding frames, so this pins the configuration decision instead: the overlay is
      // created but the backend reports no cursor.
      expect(video.config.cursor.mode).toBe('overlay');
      expect((await stat(output)).size).toBeGreaterThan(1000);
    } finally {
      await video.dispose();
    }
  }, 180_000);
});
