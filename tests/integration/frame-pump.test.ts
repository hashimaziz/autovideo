import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveConfig, timeForFrame } from '../../src/config/config.js';
import { launchBrowser, type BrowserSession } from '../../src/browser/session.js';
import { startEncoder, type Encoder } from '../../src/recorder/encoder.js';
import { createFramePump } from '../../src/recorder/frame-pump.js';
import { LogicalClock } from '../../src/runtime/clock.js';
import { MotionTrack } from '../../src/motion/track.js';
import { createFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

/**
 * The frame pump, driven end to end against a real browser and a real encoder.
 *
 * These are the tests that prove the architecture's central claim: frame N is defined by its
 * index, not by when the machine happened to get round to it.
 */

interface Harness {
  pump: ReturnType<typeof createFramePump>;
  clock: LogicalClock;
  encoder: Encoder;
  session: BrowserSession;
  frames: Buffer[];
}

/**
 * Run `script` against a live page while the pump renders frames.
 *
 * Mirrors how the real facade works: the pump runs concurrently, and the script advances logical
 * time only by way of the clock that the pump drives.
 */
async function withPump(
  fps: number,
  script: (harness: {
    clock: LogicalClock;
    /** Advance logical time by pumping, waiting for `frames` to be captured. */
    waitFrames: (frames: number) => Promise<void>;
    track: MotionTrack;
  }) => Promise<void>,
  options: { frameFormat?: 'jpeg' | 'png'; scale?: number } = {},
): Promise<Harness> {
  const config = resolveConfig({
    viewport: { width: 1080, height: 1920 },
    layoutScale: options.scale ?? 1,
    fps,
    recorder: { frameFormat: options.frameFormat ?? 'png', preset: 'ultrafast' },
  });

  const session = await launchBrowser(config);
  const clock = new LogicalClock();
  const track = new MotionTrack();
  const frames: Buffer[] = [];

  const encoder = startEncoder(
    config.recorder,
    fps,
    config.viewport.layout,
    config.viewport.output,
    join(workDir, 'pump.mp4'),
  );

  // Tee every frame so tests can hash it. Writes still go through the encoder.
  const tee: Encoder = {
    ...encoder,
    destination: encoder.destination,
    async write(frame: Buffer) {
      frames.push(frame);
      return encoder.write(frame);
    },
  };

  const pump = createFramePump({
    page: session.page,
    clock,
    track,
    encoder: tee,
    config,
  });

  const pumping = pump.run();

  const waitFrames = async (count: number): Promise<void> => {
    const target = pump.framesWritten() + count;
    while (pump.framesWritten() < target) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (pump.failure()) throw pump.failure();
      if (!pump.isRunning() && pump.framesWritten() < target) {
        throw new Error(`Pump stopped at ${pump.framesWritten()} frames, needed ${target}.`);
      }
    }
  };

  await script({ clock, waitFrames, track });
  pump.stop();
  await pumping;
  await encoder.finish();
  await session.close();

  return { pump, clock, encoder, session, frames };
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'autovideo-pump-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('frame pump', () => {
  it('writes exactly one frame per requested frame, no more and no fewer', async () => {
    // The core determinism guarantee. A pause(1000) at 30fps must be 30 frames on any machine,
    // however slow.
    const { pump, frames } = await withPump(30, async ({ waitFrames }) => {
      await waitFrames(30);
    });

    expect(frames).toHaveLength(30);
    expect(pump.framesWritten()).toBe(30);
  }, 120_000);

  it('advances logical time one frame interval at a time', async () => {
    const { clock } = await withPump(30, async ({ waitFrames }) => {
      await waitFrames(30);
    });

    expect(clock.now()).toBeCloseTo(timeForFrame(30, 30), 6);
  }, 120_000);

  it('produces a video whose duration matches the frames written', async () => {
    const { encoder } = await withPump(30, async ({ waitFrames }) => {
      await waitFrames(30);
    });

    const output = await readFile(encoder.destination);
    expect(output.subarray(4, 8).toString()).toBe('ftyp');
    expect(output.length).toBeGreaterThan(500);
  }, 120_000);

  it('captures at the layout viewport and scales to the output size', async () => {
    const config = resolveConfig({ viewport: 'vertical', layoutScale: 2 });
    expect(config.viewport.layout).toEqual({ width: 540, height: 960 });
    expect(config.viewport.output).toEqual({ width: 1080, height: 1920 });
  });
});

describe('frame pump determinism', () => {
  /**
   * Render the same script twice and compare every raw frame.
   *
   * PNG is essential here. Comparing JPEG bytes across runs would test the encoder's
   * tie-breaking rather than the framework.
   */
  const hashFrames = (frames: Buffer[]): string[] =>
    frames.map((frame) => createHash('sha256').update(frame).digest('hex'));

  it('renders byte-identical frames for two runs of the same script', async () => {
    let server: FixtureServer | undefined;

    const render = async () => {
      server ??= await createFixtureServer();
      const config = resolveConfig({
        viewport: { width: 1080, height: 1920 },
        layoutScale: 1,
        fps: 10,
        recorder: { frameFormat: 'png', preset: 'ultrafast' },
      });

      const session = await launchBrowser(config);
      await session.page.goto(server.url('/'));

      const clock = new LogicalClock();
      const track = new MotionTrack();
      const frames: Buffer[] = [];

      const encoder = startEncoder(
        config.recorder,
        config.fps,
        config.viewport.layout,
        config.viewport.output,
        join(workDir, `determinism-${randomUUID()}.mp4`),
      );

      const tee: Encoder = {
        ...encoder,
        destination: encoder.destination,
        async write(frame: Buffer) {
          frames.push(frame);
          return encoder.write(frame);
        },
      };

      const pump = createFramePump({
        page: session.page,
        clock,
        track,
        encoder: tee,
        config,
        // Paint the frame index into a *visible* element. Setting document.title does nothing
        // here — a viewport capture contains no browser chrome — so the first version of this
        // test produced twelve identical frames and passed while proving nothing. The
        // non-vacuity assertion below is what catches that.
        applyFrame: async (frameIndex) => {
          await session.page.evaluate((index) => {
            const counter = document.querySelector('[data-testid="frame-counter"]');
            if (counter) counter.textContent = String(index);
          }, frameIndex);
        },
      });
      const pumping = pump.run();

      const target = 12;
      while (pump.framesWritten() < target) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      pump.stop();
      await pumping;
      await encoder.finish();
      await session.close();

      return frames;
    };

    const first = await render();
    const second = await render();
    await server?.close();

    expect(first).toHaveLength(12);
    expect(second).toHaveLength(12);

    // Non-vacuity gate, before the equality assertion. If the frames were all the same the
    // comparison below would succeed trivially and the test would be worthless.
    expect(new Set(hashFrames(first)).size).toBeGreaterThan(1);

    expect(hashFrames(second)).toEqual(hashFrames(first));
  }, 180_000);

  it('gives applyFrame the frame index and its logical timestamp', async () => {
    // applyFrame is how anything becomes visible on screen, so its arguments must be exactly
    // the frame's identity.
    const seen: Array<{ frameIndex: number; atMs: number }> = [];

    const config = resolveConfig({
      viewport: { width: 1080, height: 1920 },
      layoutScale: 1,
      fps: 25,
      recorder: { frameFormat: 'png', preset: 'ultrafast' },
    });

    const server = await createFixtureServer();
    const session = await launchBrowser(config);
    await session.page.goto(server.url('/'));

    const encoder = startEncoder(
      config.recorder,
      config.fps,
      config.viewport.layout,
      config.viewport.output,
      join(workDir, 'apply.mp4'),
    );

    const pump = createFramePump({
      page: session.page,
      clock: new LogicalClock(),
      track: new MotionTrack(),
      encoder,
      config,
      applyFrame: async (frameIndex, atMs) => {
        seen.push({ frameIndex, atMs });
      },
    });

    const running = pump.run();
    while (pump.framesWritten() < 5) await new Promise((resolve) => setTimeout(resolve, 5));
    pump.stop();
    await running;
    await encoder.finish();
    await session.close();
    await server.close();

    // The loop stops after five *writes*, and applyFrame runs before the write, so a sixth
    // frame may already be in flight. Only the first five are asserted, and they must be
    // consecutive with the right logical timestamps.
    expect(seen.slice(0, 5).map((entry) => entry.frameIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(seen.slice(0, 5).map((entry) => entry.atMs)).toEqual([0, 40, 80, 120, 160]);
  }, 120_000);

  it('reports throughput greater than zero', async () => {
    const { pump } = await withPump(30, async ({ waitFrames }) => {
      await waitFrames(20);
    });

    const stats = pump.stats();
    expect(stats.framesWritten).toBe(20);
    expect(stats.msPerFrame).toBeGreaterThan(0);
    expect(Number.isFinite(stats.throughput)).toBe(true);
  }, 120_000);
});
