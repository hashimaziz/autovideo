/**
 * The frame pump.
 *
 * This is the loop the whole framework is built around:
 *
 *   for each frame index n:
 *     logical time = n / fps
 *     sample the motion track at that time
 *     apply it to the page
 *     capture the page
 *     hand the frame to the encoder
 *
 * Note what is *not* in that loop: any reading of the wall clock. Frame N is defined by its
 * index and nothing else. If capture is slow, the pump simply takes longer in wall-clock terms -
 * the video is identical. That is the difference between a reproducible renderer and a
 * real-time one, and it is the whole reason Playwright's screencast was rejected (see
 * ARCHITECTURE_AUDIT.md §5.1-5.2, where the screencast was measured drawing no cursor and
 * emitting wall-clock-timed frames).
 *
 * ### How it runs concurrently with the script
 *
 * The user script and the pump are separate async flows. `start()` launches the pump loop and
 * returns immediately; the script then awaits whatever it likes. Actions that animate register
 * an animation on the motion track and await the *logical clock*, which only advances as the
 * pump produces frames. So a `pause(1000)` genuinely renders 30 frames of stillness rather than
 * the script simply blocking.
 *
 * ### Capture
 *
 * CDP `Page.captureScreenshot` rather than `page.screenshot()`. It returns base64 directly,
 * avoiding an extra decode, and it is the path the throughput benchmark in the audit measured.
 * Capture is resolution-independent (~16ms, one compositor frame); encoding is not, which is why
 * the layout-viewport split exists.
 */

import type { CDPSession, Page } from 'playwright';

import type { VideoConfig } from '../config/config.js';
import type { Encoder } from '../recorder/encoder.js';
import { VideoRecorderError } from '../runtime/errors.js';
import type { LogicalClock } from '../runtime/clock.js';
import type { MotionTrack } from '../motion/track.js';
import { timeForFrame } from '../config/config.js';

/** Applies the sampled motion state to the page. Injected so it can be faked in tests. */
export type ApplyFrame = (frameIndex: number, atMs: number) => Promise<void>;

export interface FramePumpOptions {
  page: Page;
  clock: LogicalClock;
  track: MotionTrack;
  encoder: Encoder;
  config: VideoConfig;
  /** Push the sampled motion onto the page. Defaults to no-op for a minimal pump. */
  applyFrame?: ApplyFrame;
  /** Receives every frame, for frame dumping and live progress. */
  onFrame?: (frameIndex: number, atMs: number) => void;
}

export interface FramePumpStats {
  framesWritten: number;
  /** Wall-clock milliseconds spent inside the render loop. */
  elapsedMs: number;
  /** Milliseconds per frame, wall-clock. The performance figure the plan asks for. */
  msPerFrame: number;
  /** How fast the pipeline ran relative to real time. Above 1 means faster than realtime. */
  throughput: number;
}

/**
 * Drives logical time and frame capture.
 *
 * Created by {@link createFramePump}, driven with {@link FramePump.run} until the script
 * finishes.
 */
export class FramePump {
  readonly #options: FramePumpOptions;

  #running = false;
  #stopped = false;
  #failure: Error | undefined;
  #framesWritten = 0;
  #startedAtMs = 0;

  constructor(options: FramePumpOptions) {
    this.#options = options;
  }

  /** Frames successfully written so far. */
  framesWritten(): number {
    return this.#framesWritten;
  }

  /** The error that stopped the pump, if any. */
  failure(): Error | undefined {
    return this.#failure;
  }

  /**
   * Pump frames until {@link FramePump.stop} is called.
   *
   * Resolves when the loop ends. Rejects only on a capture or encoder failure — a script error
   * is the caller's business and arrives through `stop()`, not through here.
   */
  async run(): Promise<void> {
    const { page, clock, encoder, config, applyFrame, onFrame } = this.#options;
    const cdp = await page.context().newCDPSession(page);

    this.#running = true;
    this.#startedAtMs = Date.now();

    const capture = this.#makeCapture(cdp, config);

    try {
      let frameIndex = 0;

      while (!this.#stopped) {
        const atMs = timeForFrame(frameIndex, config.fps);

        // Advance logical time *before* capturing, so anything awaiting a clock deadline — an
        // action waiting out an animation, a pause — is released by this frame.
        clock.advanceTo(atMs);

        if (applyFrame) {
          await applyFrame(frameIndex, atMs);
        }

        const frame = await capture();
        if (!this.#stopped || frameIndex === 0) {
          // Always keep frame 0: a video of zero frames is invalid, and the first frame is the
          // frame the viewer sees before anything has moved.
          await encoder.write(frame);
          this.#framesWritten++;
          onFrame?.(frameIndex, atMs);
        }

        frameIndex++;
      }

      await encoder.finish();
    } catch (error) {
      this.#failure = error instanceof Error ? error : new Error(String(error));
      // Nothing will advance logical time again, so every pending `wait()` must be failed
      // rather than left hanging. This is what turns a dead pump into a reported error rather
      // than a render that never finishes.
      clock.rejectPending(this.#describeFailure());
      throw this.#failure;
    } finally {
      this.#running = false;
      await cdp.detach().catch(() => undefined);
    }
  }

  /** Stop after the current frame. */
  stop(): void {
    this.#stopped = true;
  }

  /** Whether the loop is still going. */
  isRunning(): boolean {
    return this.#running;
  }

  /** Performance figures for the manifest. */
  stats(): FramePumpStats {
    const elapsedMs = Math.max(1, Date.now() - this.#startedAtMs);
    const videoMs =
      this.#framesWritten > 0 ? timeForFrame(this.#framesWritten, this.#options.config.fps) : 0;

    return {
      framesWritten: this.#framesWritten,
      elapsedMs,
      msPerFrame: elapsedMs / Math.max(1, this.#framesWritten),
      // Video time over wall time. The plan's headline performance number.
      throughput: videoMs / elapsedMs,
    };
  }

  /**
   * Capture one frame.
   *
   * JPEG is the default because it encodes roughly 3x faster and pipes about 4x fewer bytes,
   * and capture-plus-encode throughput is what this design depends on. PNG is available for the
   * golden determinism suite, which compares lossless frames.
   */
  #makeCapture(cdp: CDPSession, config: VideoConfig): () => Promise<Buffer> {
    const { frameFormat, frameQuality } = config.recorder;

    return async () => {
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: frameFormat,
        // Quality is meaningless for PNG, and sending it makes Chromium fall back to PNG
        // regardless of what was asked for.
        ...(frameFormat === 'jpeg' ? { quality: frameQuality } : {}),
        // Viewport-only. `captureBeyondViewport` would silently stitch a full-page image whose
        // height has nothing to do with the configured frame size.
        captureBeyondViewport: false,
        fromSurface: true,
      });

      if (typeof data !== 'string') {
        throw new VideoRecorderError('Frame capture returned no image data.');
      }
      return Buffer.from(data, 'base64');
    };
  }

  /** Human-readable cause for the pending-wait rejections. */
  #describeFailure(): string {
    const message = this.#failure?.message ?? 'unknown error';
    return `The frame pump stopped after ${this.#framesWritten} frames: ${message}`;
  }
}

/** Build a pump. */
export function createFramePump(options: FramePumpOptions): FramePump {
  return new FramePump(options);
}
