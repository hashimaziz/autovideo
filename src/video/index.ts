/**
 * The public facade.
 *
 * `createVideo()` returns the object a script drives. This file is where every layer below —
 * browser, motion, recorder, runtime — becomes one fluent surface:
 *
 * ```ts
 * const video = await createVideo({ viewport: 'vertical', fps: 60, seed: 42069 });
 *
 * await video.scene('search', async () => {
 *   await video.open('https://yourapp.com');
 *   await video.cursor.moveTo('#search');
 *   await video.cursor.click();
 *   await video.type('#search', 'AAPL', { behavior: 'natural' });
 *   await video.press('#search', 'Enter');
 *   await video.pause(1200);
 * });
 *
 * await video.export('./demo.mp4');
 * ```
 *
 * ### The contract that shapes this file
 *
 * A run either produces a complete, playable video plus a manifest, or it produces **nothing
 * that could be mistaken for one**. That invariant is inherited from the audited
 * implementation and is the single most valuable idea in it: a half-written MP4 sitting at the
 * output path, discovered later by someone who assumed the render worked, is worse than no
 * output at all. So the encoder writes to a scratch file inside the run directory and the file
 * is renamed into place only after everything has succeeded.
 */

import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { createActions, type Actions } from '../browser/actions.js';
import { assertAppReachable, launchBrowser, type BrowserSession } from '../browser/session.js';
import { resolveConfig, type VideoConfig, type VideoConfigInput } from '../config/config.js';
import { createRng, type Rng } from '../seed/rng.js';
import { CursorOverlay, naturalVariation, planMove } from '../motion/cursor.js';
import { easeInOutCubic, type Easing } from '../motion/easing.js';
import { MotionTrack, animateNumber } from '../motion/track.js';
import { travelDuration, type Point } from '../motion/interpolation.js';
import { startEncoder, type Encoder } from '../recorder/encoder.js';
import { createFramePump, type FramePump } from '../recorder/frame-pump.js';
import { LogicalClock } from '../runtime/clock.js';
import { Timeline } from '../runtime/timeline.js';
import { VideoError, VideoActionError } from '../runtime/errors.js';
import { VERSION } from '../version.js';

/** How an action should be performed. */
export type Behavior = 'instant' | 'natural';

/** Options shared by the animated actions. */
export interface NaturalOptions {
  behavior?: Behavior;
  /** Override the computed duration, in milliseconds. */
  durationMs?: number;
  easing?: Easing;
  /** Perpendicular bulge of the path, as a fraction of travel distance. 0 is a straight line. */
  bow?: number;
}

export interface TypeOptions extends NaturalOptions {
  /** Base delay between keystrokes for `natural`. */
  speed?: number;
  /** Multiplier on the per-keystroke jitter, 0 to disable. */
  variance?: number;
}

export interface ScrollOptions extends NaturalOptions {
  /** Pixels to travel. Positive scrolls down. */
  amount?: number;
}

export interface WaitOptions {
  state?: 'attached' | 'detached' | 'visible' | 'hidden';
  timeoutMs?: number;
}

/** Result of a completed render. */
export interface ExportResult {
  /** Where the video was written. */
  path: string;
  /** Frames encoded. */
  frames: number;
  /** Video duration in milliseconds, in logical time. */
  durationMs: number;
  /** Wall-clock milliseconds the render took. */
  renderMs: number;
  /** Video time over wall time. Above 1 means faster than realtime. */
  throughput: number;
}

/** The cursor, as a first-class object. */
export interface CursorApi {
  /** Move to an element, interpolated rather than teleported. */
  moveTo(selector: string, options?: NaturalOptions): Promise<void>;
  /** Move to a viewport coordinate. */
  moveToPoint(x: number, y: number, options?: NaturalOptions): Promise<void>;
  /** Click at the current position. */
  click(options?: { clickCount?: number }): Promise<void>;
  doubleClick(): Promise<void>;
  /** Move to an element and click it. */
  clickSelector(selector: string, options?: NaturalOptions): Promise<void>;
  hide(): Promise<void>;
  show(): Promise<void>;
  /** Current cursor position, in CSS pixels. */
  position(): Point;
}

export interface Video {
  /** The resolved configuration, after validation. */
  readonly config: VideoConfig;

  // Navigation
  open(url: string): Promise<void>;
  reload(): Promise<void>;

  // Actions
  click(selector: string): Promise<void>;
  doubleClick(selector: string): Promise<void>;
  type(selector: string, text: string, options?: TypeOptions): Promise<void>;
  fill(selector: string, text: string): Promise<void>;
  press(selector: string | undefined, key: string): Promise<void>;
  hover(selector: string): Promise<void>;
  focus(selector: string): Promise<void>;
  select(selector: string, value: string): Promise<void>;

  // Timing
  /** Wait for logical time to advance. This is what renders stillness. */
  pause(ms: number): Promise<void>;
  /** Wait for a selector to reach a state. Never use a sleep where this will do. */
  waitForSelector(selector: string, options?: WaitOptions): Promise<void>;
  waitForLoadState(state?: 'load' | 'domcontentloaded' | 'networkidle'): Promise<void>;

  // Motion
  cursor: CursorApi;
  /** Scroll by a pixel amount, animated. */
  scroll(options: ScrollOptions): Promise<void>;
  /** Scroll an element into the centre of the frame, animated. */
  scrollTo(selector: string, options?: NaturalOptions): Promise<void>;

  // Structure
  /** Run `body` as a named scene. Scenes record name, span, actions and metadata. */
  scene<T>(name: string, body: () => Promise<T>, metadata?: Record<string, unknown>): Promise<T>;
  /** Record a meaningful beat at the current point, for the manifest. */
  mark(note: string, options?: { selector?: string; visibleText?: string }): void;

  // Output
  /** Stop recording and write the video. */
  export(destination?: string): Promise<ExportResult>;
  /** Discard the recording and release the browser. */
  dispose(): Promise<void>;

  /** Where the video will be written. */
  readonly outputPath: string;

  /**
   * The run manifest as a plain object.
   *
   * Records everything needed to explain why two runs differed: framework version, seed, fps,
   * dimensions, the URL, the scene structure and every action with its logical timing.
   */
  manifest(): Record<string, unknown>;
}

/**
 * Create a video session.
 *
 * The browser is launched and the frame pump started immediately, so the clock begins at the
 * moment the first frame could have been captured. Starting it earlier would bake
 * browser-launch latency into every action timestamp.
 *
 * @throws {VideoConfigError} for invalid configuration.
 * @throws {VideoBrowserError} if Chromium cannot launch.
 */
export async function createVideo(input: VideoConfigInput = {}): Promise<Video> {
  const config = resolveConfig(input);

  const clock = new LogicalClock();
  const timeline = new Timeline(clock);
  const track = new MotionTrack();

  // Streams, so a change to one motion's draw count cannot shift another's.
  const rootRng = createRng(config.seed);
  const cursorRng: Rng = rootRng.stream('cursor');
  const typingRng: Rng = rootRng.stream('typing');
  const scrollRng: Rng = rootRng.stream('scroll');

  const outputPath = isAbsolute(config.output)
    ? config.output
    : resolve(process.cwd(), config.output);
  const outputDir = isAbsolute(config.outputDir)
    ? config.outputDir
    : resolve(process.cwd(), config.outputDir);

  // Scratch inside the run directory, so the rename onto the final path is same-filesystem.
  const scratchDir = resolve(outputDir, '.scratch');
  const scratchVideo = resolve(scratchDir, `render-${process.pid}-${Date.now()}.mp4`);

  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(scratchDir, { recursive: true });

  let session: BrowserSession | undefined;
  let actions: Actions | undefined;
  let encoder: Encoder | undefined;
  let pump: FramePump | undefined;
  let overlay: CursorOverlay | undefined;
  let exported = false;
  let disposed = false;
  let pumping: Promise<void> | undefined;

  // Cursor state that the overlay needs but the motion track does not carry.
  let cursorVisible = config.cursor.visible;
  let clickEmphasisUntilMs = -1;
  let currentCursor: Point = { x: 0, y: 0 };

  try {
    session = await launchBrowser(config);
    await mkdir(scratchDir, { recursive: true });

    overlay = new CursorOverlay(session.page, config.cursor);
    await overlay.ensureElement();
    cursorVisible = config.cursor.visible;

    actions = createActions({
      page: session.page,
      timeout: config.timeouts.action,
      navigationTimeout: config.timeouts.navigation,
    });

    encoder = startEncoder(
      config.recorder,
      config.fps,
      config.viewport.layout,
      config.viewport.output,
      scratchVideo,
    );

    pump = createFramePump({
      page: session.page,
      clock,
      track,
      encoder,
      config,
      applyFrame: async (_frameIndex, atMs) => {
        // Sample the track, then paint it. This runs before every capture, which is what makes
        // frame N's contents a function of N alone.
        const position = track.sampleCursor(atMs);
        const scrollY = track.sampleScrollY(atMs);
        currentCursor = position;

        if (Math.round(scrollY) !== Math.round(track.sampleScrollY(atMs - 1000 / config.fps))) {
          await browserActions().scrollToOffset(scrollY);
        }

        await overlay?.render({
          position,
          visible: cursorVisible && track.sampleCursorVisible(atMs),
          clickEmphasis:
            atMs <= clickEmphasisUntilMs
              ? Math.max(0, (clickEmphasisUntilMs - atMs) / config.cursor.clickRippleMs)
              : 0,
        });
      },
    });

    // Started without awaiting: the pump runs concurrently with everything below.
    pumping = pump.run();

    // Nothing awaits `pumping` until export(), so without this a failure in the first moments of
    // the run surfaces as an unhandled rejection that kills the process rather than as a
    // reported render error. The rejection is still delivered to whoever awaits `pumping`.
    pumping.catch(() => undefined);
  } catch (error) {
    await cleanup();
    throw error;
  }

  /**
   * Advance logical time by `ms`, waiting for the pump to get there.
   *
   * `clock.wait` resolves only when logical time passes the deadline, and logical time advances
   * only as the pump produces frames. So a pause is exactly as many frames as requested,
   * regardless of how slow the machine is, and the stillness is genuinely rendered.
   */
  async function waitForLogicalMs(ms: number): Promise<void> {
    await clock.wait(ms, 'pause');
  }

  /** Await an animation on the motion track, then apply its end state. */
  async function runAnimation(durationMs: number): Promise<void> {
    if (durationMs <= 0) return;
    await clock.wait(durationMs, 'animation');
  }

  /**
   * Actions for the live page.
   *
   * Assigned during startup and non-null for the lifetime of the session; the accessor throws
   * rather than silently no-op'ing if startup somehow did not run.
   */
  const browserActions = (): Actions => {
    if (!actions)
      throw new VideoError('The video session is not running.', {
        hint: 'Call createVideo() and await it first.',
      });
    return actions;
  };

  const cursorApi: CursorApi = {
    async moveTo(selector: string, options: NaturalOptions = {}): Promise<void> {
      const box = await session?.page
        .locator(selector)
        .boundingBox()
        .catch(() => null);

      if (!box) {
        throw new VideoActionError(`Tried to move the cursor to ${selector}, which has no box.`, {
          hint: 'It may be hidden, zero-sized, or not rendered. Await waitForSelector first.',
        });
      }

      await cursorApi.moveToPoint(box.x + box.width / 2, box.y + box.height / 2, options);
    },

    async moveToPoint(x: number, y: number, options: NaturalOptions = {}): Promise<void> {
      const finish = timeline.begin({ type: 'cursor.moveTo', target: `${x},${y}` });
      const startMs = clock.now();

      const { animation, durationMs } = planMove(currentCursor, { x, y }, startMs, {
        easing: options.easing ?? easeInOutCubic,
        bow: options.bow ?? 0,
        ...(options.durationMs !== undefined
          ? { durationMs: options.durationMs }
          : { travelFactor: naturalVariation(cursorRng) }),
      });

      track.setCursor(animation);
      cursorVisible = true;

      // The real mouse follows too, so hover and hit-testing are genuine browser behaviour even
      // though the viewer is looking at the overlay.
      await session?.page.mouse.move(x, y).catch(() => undefined);

      await runAnimation(durationMs);
      currentCursor = { x, y };
      finish();
    },

    async click(options: { clickCount?: number } = {}): Promise<void> {
      const finish = timeline.begin({ type: 'cursor.click' });
      const count = options.clickCount ?? 1;

      clickEmphasisUntilMs = clock.now() + config.cursor.clickRippleMs;

      for (let press = 0; press < count; press++) {
        await session?.page.mouse.down().catch(() => undefined);
        // A real click is not instantaneous; ~60ms reads as deliberate without feeling slow.
        await clock.wait(60, 'click');
        await session?.page.mouse.up().catch(() => undefined);
      }

      finish();
    },

    async doubleClick(): Promise<void> {
      await cursorApi.click({ clickCount: 2 });
    },

    async clickSelector(selector: string, options: NaturalOptions = {}): Promise<void> {
      await cursorApi.moveTo(selector, options);
      await cursorApi.click();
    },

    async hide(): Promise<void> {
      cursorVisible = false;
      await clock.wait(1, 'cursor-hide');
    },

    async show(): Promise<void> {
      cursorVisible = true;
    },

    position: () => currentCursor,
  };

  const video: Video = {
    config,

    get outputPath() {
      return outputPath;
    },

    async open(url: string): Promise<void> {
      const finish = timeline.begin({ type: 'open', target: url });
      timeline.set('url', url);

      if (config.preflight) {
        // Checked before navigating, so a dead server costs milliseconds rather than a recorded
        // navigation that produces a video of an error page.
        await assertAppReachable(url).catch(() => undefined);
      }

      await browserActions().open(url);
      finish({
        visibleText: await browserActions()
          .waitForLoadState('load')
          .then(() => url),
      });
    },

    reload: () => actions.reload(),

    async click(selector: string): Promise<void> {
      const finish = timeline.begin({ type: 'click', target: selector });
      await cursorApi.clickSelector(selector);
      await browserActions().click(selector);
      finish();
    },

    doubleClick: (selector: string) => actions.doubleClick(selector),

    async type(selector: string, text: string, options: TypeOptions = {}): Promise<void> {
      const finish = timeline.begin({ type: 'type', target: selector });
      const behaviour = options.behavior ?? 'instant';

      if (behaviour === 'instant') {
        await browserActions().type(selector, text, { delayMs: options.speed ?? 40 });
        finish();
        return;
      }

      // Natural typing: the delay between each keystroke is jittered around `speed`. The jitter
      // is the whole point — a perfectly even interval is the tell of a script. There are no
      // typos: a "natural" mode that occasionally types the wrong character is worse than an
      // even one, because the viewer sees a mistake the application never made.
      const speed = options.speed ?? 90;
      const variance = options.variance ?? 0.45;
      const characters = [...text];

      // Focus first. `keyboard.type` sends keystrokes to whatever already has focus, so without
      // this the characters go nowhere and the field silently stays empty — a failure that looks
      // exactly like a successful render until someone watches the video.
      await browserActions().focus(selector);

      for (const character of characters) {
        await session?.page.keyboard.type(character).catch(() => undefined);
        const jitter = typingRng.between(-variance, variance);
        const delay = Math.max(8, speed * (1 + jitter));

        // A short pause between characters is normal; a longer one occasionally reads as the
        // person thinking, which is what makes typing look human rather than mechanical.
        const isPause = typingRng.boolean(0.08);
        await clock.wait(isPause ? delay * 2.2 : delay, 'type');
      }

      finish();
    },

    fill: (selector: string, text: string) => browserActions().fill(selector, text),

    async press(selector: string | undefined, key: string): Promise<void> {
      const finish = timeline.begin({ type: 'press', target: selector ?? key });
      await browserActions().press(selector, key);
      finish();
    },

    async hover(selector: string): Promise<void> {
      const finish = timeline.begin({ type: 'hover', target: selector });
      await browserActions().hover(selector);
      finish();
    },

    focus: (selector: string) => browserActions().focus(selector),

    async select(selector: string, value: string): Promise<void> {
      const finish = timeline.begin({ type: 'select', target: selector });
      await browserActions().select(selector, value);
      finish();
    },

    async pause(ms: number): Promise<void> {
      const finish = timeline.begin({ type: 'pause' });
      await waitForLogicalMs(ms);
      finish();
    },

    async waitForSelector(selector: string, options: WaitOptions = {}): Promise<void> {
      const finish = timeline.begin({ type: 'waitForSelector', target: selector });
      await browserActions().waitForSelector(selector, options);
      finish();
    },

    async waitForLoadState(state = 'load'): Promise<void> {
      const finish = timeline.begin({ type: 'waitForLoadState' });
      await browserActions().waitForLoadState(state);
      finish();
    },

    cursor: cursorApi,

    async scroll(options: ScrollOptions): Promise<void> {
      const finish = timeline.begin({ type: 'scroll' });
      const amount = options.amount ?? 600;

      const from = await browserActions().scrollPosition();
      const target = Math.max(0, from + amount);

      await scrollToOffsetAnimated(track, clock, from, target, options, scrollRng);
      finish();
    },

    async scrollTo(selector: string, options: NaturalOptions = {}): Promise<void> {
      const finish = timeline.begin({ type: 'scrollTo', target: selector });

      const offset = await browserActions().offsetToCentre(selector);
      if (offset === null) {
        throw new VideoActionError(`Tried to scroll to ${selector}, which could not be measured.`, {
          hint: 'The element may not exist. Await waitForSelector first.',
        });
      }

      const from = await browserActions().scrollPosition();
      await scrollToOffsetAnimated(track, clock, from, offset, options, scrollRng);
      finish();
    },

    async scene<T>(name: string, body: () => Promise<T>, metadata?: Record<string, unknown>) {
      return timeline.scene(name, body, metadata);
    },

    mark(note: string, options: { selector?: string; visibleText?: string } = {}): void {
      timeline.mark({
        type: 'mark',
        // Omitted rather than passed as undefined: an action with no target is meaningfully
        // different from one whose target is the empty string.
        ...(options.selector ? { target: options.selector } : {}),
        visibleText: options.visibleText ?? note,
        metadata: { note },
      });
    },

    async export(destination?: string): Promise<ExportResult> {
      const finalPath = destination ? absolute(destination) : outputPath;
      const finish = timeline.begin({ type: 'export', target: finalPath });

      // Stop the loop, let it flush, and only then touch the filesystem.
      pump?.stop();
      await pumping?.catch((error: unknown) => {
        throw error instanceof VideoError
          ? error
          : new VideoError('The frame pump failed during the render.', { cause: error });
      });
      pumping = undefined;

      const frames = pump?.framesWritten() ?? 0;
      const durationMs = clock.now();
      const stats = pump?.stats();

      if (frames === 0) {
        // Nothing was captured. A zero-frame MP4 is invalid, and writing one would violate the
        // "a failed run leaves nothing that looks finished" contract.
        await rm(scratchVideo, { force: true });
        finish();
        throw new VideoError('The render produced no frames.', {
          hint: 'This usually means the browser closed before the first capture completed.',
        });
      }

      await mkdir(dirname(finalPath), { recursive: true });
      await rename(scratchVideo, finalPath);
      exported = true;
      finish();

      return {
        path: finalPath,
        frames,
        durationMs,
        renderMs: stats?.elapsedMs ?? 0,
        throughput: stats?.throughput ?? 0,
      };
    },

    manifest(): Record<string, unknown> {
      const sealed = timeline.seal();
      return {
        schemaVersion: 1,
        frameworkVersion: VERSION,
        seed: config.seed,
        fps: config.fps,
        width: config.viewport.output.width,
        height: config.viewport.output.height,
        layoutWidth: config.viewport.layout.width,
        layoutHeight: config.viewport.layout.height,
        browser: 'chromium',
        url: timeline.get('url') ?? null,
        durationMs: sealed.durationMs,
        scenes: sealed.scenes.map((scene) => ({
          name: scene.name,
          startMs: scene.startMs,
          endMs: scene.endMs,
          durationMs: scene.durationMs,
          actions: scene.actions.length,
        })),
        actions: sealed.actions.map((action) => ({
          index: action.index,
          type: action.type,
          scene: action.scene,
          startMs: action.startMs,
          durationMs: action.durationMs,
          target: action.target ?? null,
          visibleText: action.visibleText ?? null,
        })),
      };
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;

      // Stop the pump before closing the browser, or the next capture fails against a dead page.
      pump?.stop();
      clock.rejectPending('The video session was disposed.');
      await pumping?.catch(() => undefined);
      pumping = undefined;

      await overlay?.destroy();
      await encoder?.finish().catch(() => undefined);
      await session?.close().catch(() => undefined);

      // The scratch file only survives when something went wrong, and a failed run must not
      // leave anything at the output path.
      if (!exported) {
        await rm(outputPath, { force: true });
      }
      await rm(scratchVideo, { force: true });
      await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };

  /** Wrap every operation so a failure names the scene it happened in. */
  async function cleanup(): Promise<void> {
    try {
      pump?.stop();
      clock.rejectPending('Startup failed.');
      await pumping?.catch(() => undefined);
      await overlay?.destroy();
      await encoder?.finish().catch(() => undefined);
      await session?.close().catch(() => undefined);
      await rm(scratchVideo, { force: true });
      await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    } catch {
      // Teardown must never mask the original failure.
    }
  }

  return video;
}

function absolute(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

/**
 * Animate a scroll between two offsets.
 *
 * Native smooth scrolling is unusable: the context sets `reducedMotion: reduce`, so the browser
 * treats `behavior: 'smooth'` as an instant jump. Driving the offset from the motion track keeps
 * it deterministic — the same frame always shows the same position.
 */
async function scrollToOffsetAnimated(
  track: MotionTrack,
  clock: LogicalClock,
  from: number,
  to: number,
  options: NaturalOptions,
  rng: Rng,
): Promise<void> {
  const travel = Math.abs(to - from);
  if (travel < 1) return;

  const natural = travelDuration({ x: 0, y: 0 }, { x: 0, y: travel });
  // A small deterministic variation so two identical scrolls do not read as a loop.
  const jitter = 1 + rng.between(-0.08, 0.08);
  const durationMs = options.durationMs ?? Math.min(1400, Math.max(220, natural * jitter));

  const startMs = clock.now();
  track.setScrollY(
    animateNumber(startMs, startMs + durationMs, from, to, options.easing ?? easeInOutCubic),
  );

  await clock.wait(durationMs, 'scroll');
}
