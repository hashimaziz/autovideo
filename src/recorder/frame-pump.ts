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

import type { PageGate } from '../browser/page-gate.js';
import type { VideoConfig } from '../config/config.js';
import type { Encoder } from '../recorder/encoder.js';
import { VideoRecorderError } from '../runtime/errors.js';
import type { LogicalClock } from '../runtime/clock.js';
import type { MotionTrack } from '../motion/track.js';
import { timeForFrame } from '../config/config.js';

/** Applies the sampled motion state to the page. Injected so it can be faked in tests. */
export type ApplyFrame = (frameIndex: number, atMs: number) => Promise<void>;

/**
 * Sentinel distinguishing "the work timed out" from a real result.
 * A distinct symbol rather than `null`, so a skipped frame and a timed-out one stay separable.
 */
const CAPTURE_TIMED_OUT = Symbol('capture-timed-out');
const FRAME_TIMED_OUT = Symbol('frame-timed-out');

/**
 * How long a single capture may take before it is treated as stuck.
 *
 * Captures normally take ~16ms — one compositor frame. Navigation takes 100-500ms and is skipped
 * by event rather than waited on, so anything past this bound is a capture that will not return.
 */
const CAPTURE_TIMEOUT_MS = 5_000;

/**
 * How long a navigation may go without settling before frames are captured anyway.
 *
 * Generous — a slow app can take seconds — but bounded, because some navigations never emit a
 * load event at all and the pump would otherwise emit nothing until the clock's stall guard
 * fired thirty seconds later.
 */
const NAVIGATION_GRACE_MS = 8_000;

/**
 * How long the pump will wait for `resumeCapture()` before carrying on regardless.
 *
 * A safety net, not the normal path: if a navigation somehow never calls resume, the render
 * should continue without capture rather than hang until the clock's stall guard fires.
 */
const SUPPRESS_GRACE_MS = 30_000;

/**
 * How long one frame's page work may take before it is abandoned.
 *
 * Every CDP and page call can hang rather than fail — during navigation, and occasionally for
 * reasons of Playwright's own scheduling. Without a bound, one stuck frame stalls the whole
 * render and every pending action waits out the clock's stall guard, producing a 30-second
 * mystery error that points at the pump rather than at the call that hung.
 *
 * A timed-out frame is *dropped*, not fatal: logical time does not advance for it, so the video
 * loses one frame of a single frame's duration and remains fully deterministic. Dropping a frame
 * is a far better outcome than failing a render over a transient scheduling hiccup.
 */
const FRAME_TIMEOUT_MS = 5_000;

/** Whether the page is still the pre-navigation blank document. */
function isBlankDocument(page: Page): boolean {
  const url = page.url();
  return url === 'about:blank' || url === '';
}

/**
 * Hand control back to the event loop.
 *
 * Used by the skip path so the pump cannot starve the navigation it is waiting on.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

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
  /**
   * Serialises page access against the script's own actions.
   *
   * Without it, a navigation started by the script can begin *while* the pump is inside a page
   * call, and every CDP call hangs rather than fails until the clock's stall guard fires. See
   * {@link PageGate}.
   */
  gate?: PageGate;
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

  /** True when stop() was called deliberately, rather than the loop exiting unexpectedly. */
  #stoppedCleanly = false;

  /**
   * Set while the script is performing a navigation it initiated.
   *
   * Without this there is a window between `goto()` being called and the browser emitting
   * `framenavigated` — and another between `load` firing and `goto` resolving. A frame captured
   * in either window advances logical time by one frame interval, so two runs of the same
   * script shift every subsequent timestamp by a whole frame.
   *
   * That was measured: two runs of an identical script differed by exactly one frame, with all
   * durations identical and every later start offset shifted by 33.3ms. Suppressing capture for
   * the whole navigation removes the window entirely and makes the timeline reproducible.
   */
  #suppressed = false;

  /** Resolved when {@link FramePump.resumeCapture} is called. */
  #resumed: Promise<void> | undefined;

  #resolveResumed: (() => void) | undefined;

  /**
   * Stop capturing until {@link FramePump.resumeCapture}.
   *
   * The frame loop waits on a promise rather than polling the flag. Polling it with a
   * `setImmediate` loop looks harmless and is not: it starves the event loop's poll phase, so
   * Playwright's transport never gets a turn, `goto` never completes, and the render hangs with
   * a clock stall rather than a navigation error. Waiting is both cheaper and correct.
   */
  suppressCapture(): void {
    if (this.#suppressed) return;
    this.#suppressed = true;
    this.#resumed = new Promise<void>((resolve) => {
      this.#resolveResumed = resolve;
    });
  }

  /** Resume capturing. Safe to call when not suppressed. */
  resumeCapture(): void {
    this.#suppressed = false;
    this.#resolveResumed?.();
    this.#resolveResumed = undefined;
    this.#resumed = undefined;
  }

  /** Wait until capture is unsuppressed, bounded so a lost resume cannot stall the render. */
  async #awaitResumed(): Promise<void> {
    const resumed = this.#resumed;
    if (!resumed) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SUPPRESS_GRACE_MS);
    });

    await Promise.race([resumed, grace]);
    if (timer) clearTimeout(timer);
  }

  /**
   * True between a main-frame navigation starting and its document settling.
   *
   * Capture during that window hangs forever — measured, not assumed — so it must be detected
   * rather than waited on. Bounded by {@link NAVIGATION_GRACE_MS} because a navigation that
   * *never* settles (an unreachable host ends on chrome-error:// and fires no load event) would
   * otherwise leave the flag set and stall the pump indefinitely.
   */
  #navigationSettled: Promise<void> | undefined;

  #resolveNavigation: (() => void) | undefined;

  constructor(options: FramePumpOptions) {
    this.#options = options;

    const { page } = options;

    page.on('framenavigated', (frame) => {
      // Only the main frame matters. A subframe navigating during capture would hang it just as
      // thoroughly, so every frame navigation starts a new wait.
      if (frame !== page.mainFrame()) return;
      this.#beginNavigation();
    });

    // Either event means the new document is present and settled.
    const settle = (): void => this.#endNavigation();
    page.on('domcontentloaded', settle);
    page.on('load', settle);
  }

  /** Record that a navigation has started. */
  #beginNavigation(): void {
    // A second navigation supersedes the first; the old resolver is dropped so nothing leaks.
    this.#resolveNavigation?.();
    this.#navigationSettled = new Promise<void>((resolve) => {
      this.#resolveNavigation = resolve;
    });
  }

  /** Record that the document has settled. */
  #endNavigation(): void {
    this.#resolveNavigation?.();
    this.#resolveNavigation = undefined;
    this.#navigationSettled = undefined;
  }

  /**
   * Wait until the page is safe to touch.
   *
   * Event-driven rather than polled. An earlier version re-checked a flag and yielded on every
   * iteration, which is both wasteful and — because the yield was the only thing scheduled —
   * able to stall indefinitely on a page that never settled.
   *
   * Bounded by {@link NAVIGATION_GRACE_MS}: an unreachable host ends on chrome-error:// and
   * fires no load event at all, so without a bound the pump would wait forever while the action
   * that triggered the navigation times out underneath it.
   */
  async #awaitNavigationSettled(): Promise<void> {
    const settled = this.#navigationSettled;
    if (!settled) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, NAVIGATION_GRACE_MS);
    });

    await Promise.race([settled, grace]);
    if (timer) clearTimeout(timer);
    this.#endNavigation();
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
    const { page, clock, encoder, config, applyFrame, onFrame, gate } = this.#options;
    const cdp = await page.context().newCDPSession(page);

    this.#running = true;
    this.#startedAtMs = Date.now();

    const capture = this.#makeCapture(cdp, config);

    try {
      let frameIndex = 0;

      while (!this.#stopped) {
        // Navigation is handled *before* anything touches the page. Every CDP and page call —
        // capture, `page.evaluate`, style injection — hangs rather than fails while a
        // navigation is in flight, so the whole iteration waits. Checking only the capture is
        // not enough: applyFrame issues page calls of its own.
        await this.#awaitNavigationSettled();

        // A script-initiated navigation suppresses capture for its whole duration. The frame is
        // not merely skipped after the fact — logical time does not advance at all, so nothing
        // downstream shifts.
        await this.#awaitResumed();

        const atMs = timeForFrame(frameIndex, config.fps);

        // Applying motion and capturing both touch the page, so they happen together under the
        // gate. Writing to the encoder deliberately stays outside it: ffmpeg is not the page,
        // and holding the gate during an encode would stall the script for no reason.
        const renderFrame = async (): Promise<Buffer | null> => {
          if (applyFrame) await applyFrame(frameIndex, atMs);
          return this.#captureOrSkip(page, capture);
        };

        // The gate is acquired with a deadline and released by *this* frame's `finally`.
        // Wrapping the frame in `gate.withLock` and abandoning it on timeout leaks the gate
        // permanently, because the release lives in the abandoned promise's `finally`.
        let holdingGate = false;
        if (gate) {
          holdingGate = await gate.tryAcquire(FRAME_TIMEOUT_MS);
          if (!holdingGate) {
            // Could not get the page within the deadline. Skip rather than stall.
            await yieldToEventLoop();
            continue;
          }
        }

        let frame: Buffer | null;
        try {
          frame = await this.#withDeadline(renderFrame());
        } finally {
          if (holdingGate) gate?.release();
        }

        // If stop() landed while this frame was being captured, do not write it. Without this
        // the count overshoots by one: the loop is awaiting a capture when the caller stops it,
        // so the frame it was already working on gets written anyway. That is how
        // `pause(1000)` at 30fps came to emit 31 frames.
        //
        if (this.#stopped && frameIndex > 0) {
          continue;
        }

        // Never capture the pre-navigation blank page.
        //
        // `Page.captureScreenshot` *succeeds* on about:blank — it returns a small white image —
        // so the URL check inside `#captureOrSkip` never fires and the frame gets written. Whether
        // the pump wins the race against the script's first `open()` call then decides whether the
        // video begins with one extra frame, which is a coin flip rather than a decision.
        //
        // Skipping it outright makes the start deterministic: frame 0 is always the application's
        // first paint.
        if (frameIndex === 0 && isBlankDocument(page)) {
          await yieldToEventLoop();
          continue;
        }

        if (frame === null) {
          // Skipped. Logical time deliberately does *not* advance: the frame index is the
          // definition of time, so a frame that was not captured must not consume one. If it
          // did, the video's length would depend on how long each navigation happened to take,
          // which is exactly the machine-dependence this design exists to remove.
          // Yield rather than spin: a skipped frame means no page work happened, so give the
          // event loop a turn to finish whatever caused it.
          await yieldToEventLoop();
          continue;
        }

        clock.advanceTo(timeForFrame(frameIndex, config.fps));

        // Raced against the encoder's own exit.
        //
        // `write` resolves via a `drain` event when ffmpeg's stdin buffer fills. If ffmpeg has
        // died — or stopped consuming — that event never fires and the pump waits forever with
        // no error and no frames. Racing against `done` turns an unkillable hang into an
        // immediate, accurate failure.
        await Promise.race([
          encoder.write(frame),
          encoder.done.then(() => {
            throw new VideoRecorderError(
              `The encoder exited after ${this.#framesWritten} frames.`,
              {
                hint: 'ffmpeg stopped consuming frames. Check the encoder log and the capture size.',
              },
            );
          }),
        ]);

        this.#framesWritten++;
        onFrame?.(frameIndex, atMs);

        // Advance to the *end* of this frame's interval, not the frame's presentation time.
        // Frame k is shown at k/fps, but after writing it the video has consumed (k+1)/fps of
        // time. Advancing only to k/fps makes every pause one frame long: pause(1000) at 30fps
        // would emit 31 frames instead of 30.
        clock.advanceTo(timeForFrame(frameIndex + 1, config.fps));

        frameIndex++;
      }

      // The loop ending means no more frames will ever be produced. Anything still awaiting a
      // logical deadline must be failed *now*: left alone it waits out the clock's stall guard
      // for 30 seconds and then reports "no frames were produced", which points at the pump
      // rather than at whatever actually stopped it.
      if (!this.#stoppedCleanly) {
        clock.rejectPending('The frame pump stopped while an action was still running.');
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

  /**
   * Await `work`, giving up after {@link FRAME_TIMEOUT_MS}.
   *
   * Returns null when the work is abandoned. The underlying promise is deliberately left
   * running rather than cancelled: there is no way to cancel a CDP call in flight, and it will
   * settle once the page is responsive again. Its failure is absorbed so it cannot resurface
   * later as an unhandled rejection.
   */
  async #withDeadline(work: Promise<Buffer | null>): Promise<Buffer | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<typeof FRAME_TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(FRAME_TIMED_OUT), FRAME_TIMEOUT_MS);
    });

    try {
      const result = await Promise.race([work, expiry]);
      return result === FRAME_TIMED_OUT ? null : result;
    } finally {
      if (timer) clearTimeout(timer);
      work.catch(() => undefined);
    }
  }

  /**
   * Capture a frame, or report that there is nothing to capture yet.
   *
   * Two cases return null rather than throwing, and everything else propagates. A broken CDP
   * session must never be mistaken for "the page has not loaded yet", because that would turn a
   * crashed render into a silently short video.
   */
  async #captureOrSkip(page: Page, capture: () => Promise<Buffer>): Promise<Buffer | null> {
    if (page.isClosed()) return null;

    // Backstop. Captures normally take ~16ms; a navigation takes 100-500ms. Anything past this
    // is a stuck capture, and abandoning it is safer than blocking the run forever. The abandoned
    // promise is given its own catch so it cannot surface later as an unhandled rejection.
    const timeout = new Promise<typeof CAPTURE_TIMED_OUT>((resolve) => {
      const handle = setTimeout(() => resolve(CAPTURE_TIMED_OUT), CAPTURE_TIMEOUT_MS);
      handle.unref?.();
    });

    const attempt = capture().then(
      (frame) => frame,
      (error: unknown) => {
        throw error;
      },
    );

    try {
      const result = await Promise.race([attempt, timeout]);
      return result === CAPTURE_TIMED_OUT ? null : result;
    } catch (error) {
      void attempt.catch(() => undefined);

      // Before the first navigation the page is about:blank, which has no renderer target and
      // reports either "Not attached to an active page" or "Unable to capture screenshot". Those
      // frames are white anyway, so they are skipped rather than treated as failures.
      //
      // The URL is the signal, not `document.readyState`: about:blank reports readyState
      // 'complete', which made an earlier version of this check rethrow and kill every run.
      const url = page.url();
      if (url === 'about:blank' || url === '') return null;

      // Anything after that is a genuine capture failure and belongs in the run manifest.
      throw error;
    }
  }

  /**
   * Stop after the current frame.
   *
   * Deliberate — called by export() and dispose() when the script is finishing.
   */
  stop(): void {
    this.#stoppedCleanly = true;
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
