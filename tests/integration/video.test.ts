import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createVideo, type Video } from '../../src/video/index.js';
import { probeDurationSeconds } from '../../src/recorder/encoder.js';
import { createFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

/**
 * The public API, end to end.
 *
 * These write real MP4s to a temporary directory. The claim under test is the one the whole
 * project rests on: a developer writes a short script and reliably gets a playable vertical video.
 */

describe('createVideo — end to end', () => {
  let server: FixtureServer;
  let workDir: string;

  beforeAll(async () => {
    server = await createFixtureServer();
    workDir = await mkdtemp(join(tmpdir(), 'autovideo-e2e-'));
  });

  afterAll(async () => {
    await server?.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it('renders a playable vertical MP4 from a short script', async () => {
    const output = join(workDir, 'basic.mp4');
    const video: Video = await createVideo({
      viewport: 'vertical',
      fps: 30,
      seed: 42069,
      output,
      outputDir: workDir,
      recorder: { preset: 'ultrafast' },
    });

    try {
      await video.open(server.url('/'));
      await video.waitForSelector('#ticker');

      await video.cursor.moveTo('#ticker');
      await video.type('#ticker', 'AAPL', { behavior: 'natural', speed: 20 });
      await video.press('#ticker', 'Enter');
      await video.pause(400);

      await video.click('[data-testid="analyse-button"]');
      await video.waitForSelector('[data-testid="results"]', { state: 'visible' });
      await video.pause(400);

      const result = await video.export();

      expect(result.path).toBe(output);
      expect(result.frames).toBeGreaterThan(30);

      const bytes = await readFile(output);
      // A valid MP4 begins with an ftyp box. Existence alone would prove nothing.
      expect(bytes.subarray(4, 8).toString()).toBe('ftyp');
      expect(bytes.length).toBeGreaterThan(2000);
    } finally {
      await video.dispose();
    }
  }, 180_000);

  it('produces a video whose duration matches the script', async () => {
    const output = join(workDir, 'timing.mp4');
    const video = await createVideo({
      viewport: 'vertical',
      fps: 30,
      seed: 1,
      output,
      outputDir: workDir,
      recorder: { preset: 'ultrafast' },
    });

    try {
      await video.open(server.url('/'));
      await video.pause(1000);

      const result = await video.export();

      // 1000ms at 30fps is 30 frames. The container rounds to the nearest frame boundary.
      const duration = await probeDurationSeconds(output);
      expect(duration).not.toBeNull();
      expect(duration as number).toBeCloseTo(result.durationMs / 1000, 1);
    } finally {
      await video.dispose();
    }
  }, 180_000);

  it('renders a pause as exactly the requested duration of logical time', async () => {
    // The determinism claim in its most direct form: a pause occupies exactly the span of video
    // time the script asked for, regardless of how slow the machine was. Asserted through the
    // manifest rather than by counting frames mid-run, because `open()` legitimately produces
    // frames of its own before the pause begins.
    const run = async (): Promise<{ frames: number; durationMs: number; pauses: number[] }> => {
      const video = await createVideo({
        viewport: { width: 1080, height: 1920 },
        layoutScale: 1,
        fps: 30,
        seed: 7,
        output: join(workDir, `pause-${Date.now()}-${Math.random()}.mp4`),
        outputDir: workDir,
        recorder: { preset: 'ultrafast' },
      });

      try {
        await video.open(server.url('/'));
        await video.pause(1000);
        const result = await video.export();

        const actions = video.manifest().actions as Array<{ type: string; durationMs: number }>;
        return {
          frames: result.frames,
          durationMs: result.durationMs,
          pauses: actions.filter((a) => a.type === 'pause').map((a) => a.durationMs),
        };
      } finally {
        await video.dispose();
      }
    };

    const first = await run();
    const second = await run();

    // The pause itself is exactly 1000ms of logical time.
    // Compared approximately: repeated float addition makes the accumulated logical time
    // 1000.0000000000001 rather than exactly 1000.
    expect(first.pauses[0]).toBeCloseTo(1000, 6);
    expect(second.pauses[0]).toBeCloseTo(1000, 6);

    // Frames track logical time exactly — this is the property a wall-clock pump cannot have.
    // A capture that is skipped (during navigation) must not consume a frame index either.
    expect(first.frames).toBe(Math.round((first.durationMs / 1000) * 30));
    expect(second.frames).toBe(Math.round((second.durationMs / 1000) * 30));

    // And two runs of the same script agree on both.
    expect(second.frames).toBe(first.frames);
    expect(second.durationMs).toBe(first.durationMs);
  }, 240_000);

  it('records scenes and actions into the manifest', async () => {
    const video = await createVideo({
      viewport: 'vertical',
      fps: 30,
      seed: 42,
      output: join(workDir, 'manifest.mp4'),
      outputDir: workDir,
      recorder: { preset: 'ultrafast' },
    });

    try {
      await video.scene('open', async () => {
        await video.open(server.url('/'));
        await video.pause(200);
      });

      await video.scene('search', async () => {
        await video.cursor.moveTo('#ticker');
        await video.type('#ticker', 'TSLA', { speed: 10 });
        await video.mark('Ticker entered', { selector: '#ticker' });
        await video.pause(200);
      });

      await video.export();
      const manifest = video.manifest();

      expect(manifest.seed).toBe(42);
      expect(manifest.fps).toBe(30);
      expect(manifest.width).toBe(1080);
      expect(manifest.height).toBe(1920);
      expect(manifest.browser).toBe('chromium');
      expect(String(manifest.url)).toContain('127.0.0.1');

      const scenes = manifest.scenes as Array<{ name: string; durationMs: number }>;
      expect(scenes.map((scene) => scene.name)).toEqual(['open', 'search']);

      const actions = manifest.actions as Array<{ type: string; scene: string | null }>;
      expect(actions.some((action) => action.type === 'open')).toBe(true);
      expect(actions.some((action) => action.type === 'type')).toBe(true);
      expect(actions.some((action) => action.type === 'cursor.moveTo')).toBe(true);
      // Every action inside a scene must be attributed to it.
      expect(actions.filter((a) => a.type === 'cursor.moveTo')[0]?.scene).toBe('search');
    } finally {
      await video.dispose();
    }
  }, 180_000);

  it('scrolls to an element far down the page', async () => {
    const output = join(workDir, 'scroll.mp4');
    const video = await createVideo({
      viewport: 'vertical',
      fps: 30,
      seed: 3,
      output,
      outputDir: workDir,
      recorder: { preset: 'ultrafast' },
    });

    try {
      await video.open(server.url('/'));
      await video.scrollTo('[data-testid="chart-panel"]', { behavior: 'natural' });
      await video.pause(300);

      const result = await video.export();
      expect(result.frames).toBeGreaterThan(10);
      expect((await stat(output)).size).toBeGreaterThan(1000);
    } finally {
      await video.dispose();
    }
  }, 180_000);

  it('leaves no video behind when the script throws', async () => {
    // The invariant inherited from the audited implementation, and the reason the encoder
    // writes to a scratch file: a failed run must not leave something that looks finished.
    const output = join(workDir, 'should-not-exist.mp4');

    const video = await createVideo({
      viewport: 'vertical',
      fps: 30,
      output,
      outputDir: workDir,
      recorder: { preset: 'ultrafast' },
    });

    await expect(
      (async () => {
        await video.open(server.url('/'));
        await video.click('#a-selector-that-does-not-exist');
        await video.export();
      })(),
    ).rejects.toThrow();

    await video.dispose();

    await expect(stat(output)).rejects.toThrow();
  }, 180_000);

  it('renders a landscape video at the right dimensions', async () => {
    const output = join(workDir, 'landscape.mp4');
    const video = await createVideo({
      viewport: 'landscape',
      fps: 30,
      output,
      outputDir: workDir,
      recorder: { preset: 'ultrafast' },
    });

    try {
      await video.open(server.url('/'));
      await video.pause(400);
      await video.export();

      const { spawnSync } = await import('node:child_process');
      const { resolveFfmpegBinary } = await import('../../src/recorder/encoder.js');
      const probe = spawnSync(resolveFfmpegBinary() as string, ['-hide_banner', '-i', output], {
        encoding: 'utf8',
      });

      // The preset resolves to 1920x1080 output, and the encoder must actually produce that.
      expect(probe.stderr).toMatch(/1920x1080/);
    } finally {
      await video.dispose();
    }
  }, 180_000);

  it('disposes cleanly when never exported', async () => {
    const video = await createVideo({
      viewport: 'vertical',
      fps: 30,
      output: join(workDir, 'disposed.mp4'),
      outputDir: workDir,
    });

    await video.open(server.url('/'));
    await video.dispose();

    // Idempotent, and nothing at the output path.
    await expect(video.dispose()).resolves.toBeUndefined();
    await expect(stat(join(workDir, 'disposed.mp4'))).rejects.toThrow();
  }, 120_000);

  it('rejects invalid configuration before launching anything', async () => {
    // A config error must not cost a browser launch.
    await expect(createVideo({ fps: 0 })).rejects.toThrow(/fps/);
    await expect(createVideo({ viewport: 'cinemascope' })).rejects.toThrow(/preset/i);
  });
});
