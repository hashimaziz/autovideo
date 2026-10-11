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

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { createActions, type Actions } from '../browser/actions.js';
import { PageGate } from '../browser/page-gate.js';
import { assertAppReachable, launchBrowser, type BrowserSession } from '../browser/session.js';
import { resolveConfig, type VideoConfig, type VideoConfigInput } from '../config/config.js';
import { createRng, type Rng } from '../seed/rng.js';
import { CursorOverlay, naturalVariation, planMove } from '../motion/cursor.js';
import {
  HighlightOverlay,
  resolveHighlightOptions,
  type HighlightOptions,
} from '../motion/highlight.js';
import { easeInOutCubic, type Easing } from '../motion/easing.js';
import { MotionTrack, animateNumber } from '../motion/track.js';
import { travelDuration, type Point } from '../motion/interpolation.js';
import { startEncoder, type Encoder } from '../recorder/encoder.js';
import { createFramePump, type FramePump } from '../recorder/frame-pump.js';
import {
  startScreencastRecorder,
  trimVideo,
  type ScreencastRecorder,
} from '../recorder/screencast.js';
import { LogicalClock } from '../runtime/clock.js';
import { BrowserLog, captureDiagnostics } from '../runtime/diagnostics.js';
import { asRenderError, VideoRenderError, type ArtifactList } from '../runtime/render-error.js';
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

  /**
   * Ring an element, and advance logical time through the fade so it actually renders.
   *
   * Only one highlight is up at a time: calling this again moves the ring rather than stacking a
   * second one, because two rings on screen is a question the viewer has to answer instead of a
   * thing the video told them.
   *
   * The ring re-measures the element every frame, so it stays put through scrolling and reflow.
   * Pass `durationMs` to have it fade out on its own; otherwise it stays until the next
   * `highlight()` or an explicit `clearHighlight()`.
   */
  highlight(selector: string, options?: HighlightOptions): Promise<void>;
  /** Fade the current highlight out and advance logical time through it. */
  clearHighlight(): Promise<void>;

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
 * Replaces what {@link createVideo} returns.
 *
 * Set by the CLI's `inspect` command so that a script which builds its own session — the shape
 * the plan's own example uses — can be walked without launching a browser. Without this, `inspect`
 * only works for scripts written as `export default async (video) => {}`, and the other perfectly
 * ordinary style fails by trying to render for real.
 *
 * Internal: not part of the public API, and not covered by the compatibility promise.
 */
let factoryOverride: ((input: VideoConfigInput) => Promise<Video>) | undefined;

/** Install a replacement for {@link createVideo}. Returns a function that restores the original. */
export function setVideoFactory(override: (input: VideoConfigInput) => Promise<Video>): () => void {
  const previous = factoryOverride;
  factoryOverride = override;
  return () => {
    factoryOverride = previous;
  };
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
  // Honour an installed override before doing anything else, so inspecting a script never
  // launches a browser.
  if (factoryOverride) return factoryOverride(input);

  const config = resolveConfig(input);

  const clock = new LogicalClock();
  const timeline = new Timeline(clock);
  const track = new MotionTrack();
  const log = new BrowserLog();

  /**
   * Serialises the pump's page access against the script's own.
   *
   * Navigation takes priority, so a pump that re-acquires the gate between every frame cannot
   * starve it. Without this the pump deadlocks intermittently — and intermittently is the worst
   * possible way for a renderer to fail.
   */
  const gate = new PageGate();

  /** The action currently executing, so a failure can name it. */
  let currentAction: { type: string; target: string | undefined } | undefined;

  const outputDir = isAbsolute(config.outputDir)
    ? config.outputDir
    : resolve(process.cwd(), config.outputDir);

  /**
   * Identifies this run in artefact paths.
   *
   * A timestamp rather than nothing: diagnostics are most valuable when several runs are
   * compared, and overwriting the previous failure destroys the only copy of the bug you just
   * spent an hour reproducing.
   */
  const runStamp = new Date().toISOString().replace(/[:.]/g, '-');

  /**
   * Where a failed run writes its diagnostics.
   *
   * A relative `debug.dir` resolves against `outputDir`, not the current working directory, so
   * diagnostics land beside the video they explain rather than wherever the CLI happened to be
   * run from.
   */
  const debugDir = isAbsolute(config.debug.dir)
    ? resolve(config.debug.dir, runStamp)
    : resolve(outputDir, config.debug.dir, runStamp);

  // Streams, so a change to one motion's draw count cannot shift another's.
  const rootRng = createRng(config.seed);
  const cursorRng: Rng = rootRng.stream('cursor');
  const typingRng: Rng = rootRng.stream('typing');
  const scrollRng: Rng = rootRng.stream('scroll');

  const outputPath = isAbsolute(config.output)
    ? config.output
    : resolve(process.cwd(), config.output);
  // Scratch inside the run directory, so the rename onto the final path is same-filesystem.
  const scratchDir = resolve(outputDir, '.scratch');
  const scratchVideo = resolve(scratchDir, `render-${process.pid}-${Date.now()}.mp4`);
  /** Where Chromium writes screencast segments, before they are flushed and converted. */
  const rawScreencastDir = resolve(scratchDir, 'screencast');

  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(scratchDir, { recursive: true });

  let session: BrowserSession | undefined;
  let actions: Actions | undefined;
  let encoder: Encoder | undefined;
  let pump: FramePump | undefined;
  let screencast: ScreencastRecorder | undefined;
  /** Detaches the wall-clock driver in screencast mode; undefined in frame-pump mode. */
  let detachWallClock: (() => void) | undefined;
  let overlay: CursorOverlay | undefined;

  let highlightOverlay: HighlightOverlay | undefined;

  /**
   * The live highlight, or null.
   *
   * `fadeFromMs`/`fadeOutMs` are logical timestamps, so a fade is sampled per frame exactly like
   * cursor movement: the ring's opacity is a function of the frame index, not of how long the
   * render happened to take.
   */
  let highlightState: {
    selector: string;
    options: ReturnType<typeof resolveHighlightOptions>;
    fadeFromMs: number;
    fadeOutMs: number | null;
  } | null = null;
  let exported = false;
  let lastExport: ExportResult | undefined;
  let disposed = false;
  let pumping: Promise<void> | undefined;

  // Cursor state that the overlay needs but the motion track does not carry.
  let cursorVisible = config.cursor.visible;
  let clickEmphasisUntilMs = -1;
  let currentCursor: Point = { x: 0, y: 0 };

  // Wall-clock origin for the screencast backend, which has no frame pump to report timing from.
  const renderStartedAt = Date.now();

  // The screencast backend cannot use the layout split: Playwright's screencast only ever scales
  // down, so a capture larger than the viewport comes back padded with grey bars rather than
  // enlarged. The browser therefore lays out at the output resolution — which also means the
  // result is only as legible as a 1:1 render, one of the reasons this is not the default.
  const useScreencast = config.recorder.backend === 'screencast';

  try {
    session = await launchBrowser(
      config,
      useScreencast ? { recordVideo: { dir: rawScreencastDir, size: config.viewport.output } } : {},
    );
    await mkdir(scratchDir, { recursive: true });
    if (useScreencast) await mkdir(rawScreencastDir, { recursive: true });

    log.attach(session.page);

    // Tracing is context-scoped and must be started before anything is recorded, or the early
    // frames — usually the ones that explain the failure — are missing from it.
    if (config.debug.trace) {
      await session.startTrace();
    }

    overlay = new CursorOverlay(session.page, config.cursor);
    await overlay.ensureElement();
    cursorVisible = config.cursor.visible;
    highlightOverlay = new HighlightOverlay(session.page);

    actions = createActions({
      page: session.page,
      timeout: config.timeouts.action,
      navigationTimeout: config.timeouts.navigation,
    });

    if (useScreencast) {
      // No frame pump means nothing advances logical time, so a `pause` would wait on a deadline
      // that never arrives. Wall-clock time drives the clock instead — accepting, deliberately,
      // that timing now depends on the machine.
      detachWallClock = clock.attachWallClock();

      screencast = startScreencastRecorder((destination) => session!.saveScreencast(destination), {
        config: config.recorder,
        size: config.viewport.output,
        scratchVideo,
        destination: scratchVideo.replace(/\.mp4$/, '.screencast.mp4'),
      });

      // The cursor overlay is pointless here: the screencast does not capture it. Saying so up
      // front beats shipping a cursor API that silently does nothing on this backend.
      cursorVisible = false;
    } else {
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
        gate,
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

          if (highlightState) {
            // A target that vanished mid-scene must not leave a ring floating over whatever now
            // occupies that space, so the paint reports back and the state is dropped with it.
            const painted = await highlightOverlay?.render({
              selector: highlightState.selector,
              opacity: sampleHighlight(highlightState, atMs),
              options: highlightState.options,
            });

            if (painted === false) highlightState = null;
          } else if (highlightOverlay) {
            await highlightOverlay.clear();
          }
        },
      });

      // Started without awaiting: the pump runs concurrently with everything below.
      pumping = pump.run();

      // Nothing awaits `pumping` until export(), so without this a failure in the first moments
      // of the run surfaces as an unhandled rejection that kills the process rather than as a
      // reported render error. The rejection is still delivered to whoever awaits `pumping`.
      pumping.catch(() => undefined);
    }
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
      await gate
        .withLock(() => session?.page.mouse.move(x, y) ?? Promise.resolve())
        .catch(() => undefined);

      await runAnimation(durationMs);
      currentCursor = { x, y };
      finish();
    },

    async click(options: { clickCount?: number } = {}): Promise<void> {
      const finish = timeline.begin({ type: 'cursor.click' });
      const count = options.clickCount ?? 1;

      clickEmphasisUntilMs = clock.now() + config.cursor.clickRippleMs;

      for (let press = 0; press < count; press++) {
        await gate
          .withLock(() => session?.page.mouse.down() ?? Promise.resolve())
          .catch(() => undefined);
        // A real click is not instantaneous; ~60ms reads as deliberate without feeling slow.
        await clock.wait(60, 'click');
        await gate
          .withLock(() => session?.page.mouse.up() ?? Promise.resolve())
          .catch(() => undefined);
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
      currentAction = { type: 'open', target: url };
      const finish = timeline.begin({ type: 'open', target: url });
      timeline.set('url', url);

      if (config.preflight) {
        // Checked before navigating, so a dead server costs milliseconds rather than a recorded
        // navigation that produces a video of an error page.
        await assertAppReachable(url).catch(() => undefined);
      }

      // Capture is suppressed for the whole navigation, and the gate is taken with priority.
      //
      // Both matter. The gate, because every CDP and page call *hangs* rather than fails while a
      // navigation is in flight, so the pump must not be inside one when goto starts. Priority,
      // because the pump re-acquires the gate between every frame and would otherwise starve it.
      //
      // Suppression matters for reproducibility: it removes the window between goto() being
      // called and the browser emitting 'framenavigated', and again between 'load' firing and
      // goto resolving. A frame captured in either window advances logical time by one frame
      // interval, which was measured shifting every later timestamp in the manifest.
      pump?.suppressCapture();
      try {
        await gate.withLock(() => browserActions().open(url), true);
      } finally {
        pump?.resumeCapture();
      }
      finish({ visibleText: url });
    },

    async reload(): Promise<void> {
      const finish = timeline.begin({ type: 'reload' });
      pump?.suppressCapture();
      try {
        await gate.withLock(() => browserActions().reload(), true);
      } finally {
        pump?.resumeCapture();
      }
      finish();
    },

    async click(selector: string): Promise<void> {
      currentAction = { type: 'click', target: selector };
      const finish = timeline.begin({ type: 'click', target: selector });
      await cursorApi.clickSelector(selector);
      await browserActions().click(selector);
      finish();
    },

    doubleClick: (selector: string) => cursorApi.clickSelector(selector),

    async type(selector: string, text: string, options: TypeOptions = {}): Promise<void> {
      currentAction = { type: 'type', target: selector };
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
        await gate
          .withLock(() => session?.page.keyboard.type(character) ?? Promise.resolve())
          .catch(() => undefined);
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
      currentAction = { type: 'press', target: selector ?? key };
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
      currentAction = { type: 'waitForSelector', target: selector };
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
      currentAction = { type: 'scrollTo', target: selector };
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

    async highlight(selector: string, options: HighlightOptions = {}): Promise<void> {
      // An already-fading highlight is finished first, so two highlights never overlap on screen
      // and the caller never has to think about clearing by hand.
      if (highlightState?.fadeOutMs !== null && highlightState !== null) {
        await video.clearHighlight();
      }

      currentAction = { type: 'highlight', target: selector };
      const finish = timeline.begin({ type: 'highlight', target: selector });

      const resolved = resolveHighlightOptions(options);
      highlightState = {
        selector,
        options: resolved,
        fadeFromMs: clock.now(),
        fadeOutMs: options.durationMs === undefined ? null : clock.now() + options.durationMs,
      };

      // Advancing the clock is what renders the fade. Without it the ring would snap on and the
      // fade would never appear in the video, however long the caller subsequently pauses.
      await clock.wait(resolved.fadeMs, 'highlight');

      if (options.durationMs !== undefined) {
        // Let the ring hold for its full duration before the caller gets control back.
        await clock.wait(options.durationMs, 'highlight');
        highlightState.fadeOutMs = clock.now();
        await clock.wait(resolved.fadeMs, 'highlight');
        highlightState = null;
      }

      finish();
    },

    async clearHighlight(): Promise<void> {
      if (!highlightState) return;

      currentAction = { type: 'clearHighlight', target: highlightState.selector };
      const finish = timeline.begin({ type: 'clearHighlight', target: highlightState.selector });

      highlightState.fadeOutMs = clock.now();
      await clock.wait(highlightState.options.fadeMs, 'highlight');
      highlightState = null;

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
      // Idempotent. A script is free to call export() itself — the documented API in the plan
      // shows exactly that — and a caller (a CLI, a test) may reasonably call it too. Without
      // this, the second call throws ENOENT because the scratch file was renamed away by the
      // first, and the failure surfaces as a broken render rather than as a redundant call.
      if (exported && lastExport) return lastExport;

      const finalPath = destination ? absolute(destination) : outputPath;
      const finish = timeline.begin({ type: 'export', target: finalPath });

      // Frame-pump backend: stop the loop and let it flush.
      // Screencast backend: no loop exists, so there is nothing to stop.
      pump?.stop();
      await pumping?.catch((error: unknown) => {
        throw error instanceof VideoError
          ? error
          : new VideoError('The frame pump failed during the render.', { cause: error });
      });
      pumping = undefined;

      const stats = pump?.stats();
      const durationMs = clock.now();
      let frames: number;

      await mkdir(dirname(finalPath), { recursive: true });

      if (screencast) {
        // Land exactly on real elapsed time before measuring, so the trim does not cut a frame
        // the script was still waiting on.
        detachWallClock?.();
        detachWallClock = undefined;

        const converted = scratchVideo.replace(/\.mp4$/, '.screencast.mp4');
        frames = Math.round((durationMs / 1000) * config.fps);

        await screencast.finish(durationMs / 1000);
        // The screencast keeps running over a static page during teardown, which would otherwise
        // ship as a frozen tail. Trimming to the script's own duration removes it.
        await trimVideo(converted, durationMs / 1000, config.recorder);
        await rename(converted, finalPath);
      } else {
        frames = pump?.framesWritten() ?? 0;

        if (frames === 0) {
          // Nothing was captured. A zero-frame MP4 is invalid, and writing one would violate the
          // "a failed run leaves nothing that looks finished" contract.
          await rm(scratchVideo, { force: true });
          finish();
          throw new VideoError('The render produced no frames.', {
            hint: 'This usually means the browser closed before the first capture completed.',
          });
        }

        await rename(scratchVideo, finalPath);
      }

      exported = true;
      finish();

      // The frame pump measures itself; the screencast has no pump, so its render time is the
      // wall clock from session start to here. Reporting 0 for a backend that does real work
      // would make the benchmark meaningless.
      const renderMs = stats?.elapsedMs ?? Date.now() - renderStartedAt;

      lastExport = {
        path: finalPath,
        frames,
        durationMs,
        renderMs,
        throughput: renderMs > 0 ? durationMs / renderMs : 0,
      };

      // The manifest sits beside the video, not in the debug directory: it is part of the
      // output, not evidence of a failure. Without it two runs cannot be compared after the
      // fact, which is the entire point of recording one.
      await writeFile(
        `${finalPath.replace(/\.mp4$/, '')}.manifest.json`,
        `${JSON.stringify(manifestDocument('success'), null, 2)}\n`,
        'utf8',
      ).catch(() => undefined);

      return lastExport;
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
      // The wall-clock driver must be detached before the browser closes, or it keeps advancing
      // the clock against a dead page.
      detachWallClock?.();
      detachWallClock = undefined;
      clock.rejectPending('The video session was disposed.');
      await pumping?.catch(() => undefined);
      pumping = undefined;

      await overlay?.destroy();
      await highlightOverlay?.destroy();
      await encoder?.finish().catch(() => undefined);
      await session?.close().catch(() => undefined);

      // The scratch file only survives when something went wrong, and a failed run must not
      // leave anything at the output path.
      if (!exported) {
        await rm(outputPath, { force: true });
      }
      await rm(scratchVideo, { force: true });
      await rm(rawScreencastDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };

  /** Release everything, never masking the failure that prompted it. */
  async function cleanup(): Promise<void> {
    try {
      pump?.stop();
      detachWallClock?.();
      detachWallClock = undefined;
      clock.rejectPending('The render failed.');
      await pumping?.catch(() => undefined);
      await overlay?.destroy();
      await highlightOverlay?.destroy();
      await encoder?.finish().catch(() => undefined);
      await session?.close().catch(() => undefined);
      await rm(scratchVideo, { force: true });
      await rm(rawScreencastDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    } catch {
      // Teardown must never mask the original failure.
    }
  }

  /**
   * Turn any thrown value into a reported, diagnosable failure.
   *
   * This is the plan's §20 contract: scene, action, selector, URL, elapsed time, and where the
   * artefacts are. The trace is written *before* the context closes — stopping it afterwards
   * fails with "Target page, context or browser has been closed" and loses the whole recording.
   */
  async function reportFailure(error: unknown): Promise<VideoRenderError> {
    const context = {
      scene: timeline.currentScene() ?? undefined,
      action: currentAction?.type,
      selector: currentAction?.target,
      url: session ? session.page.url() : undefined,
      elapsedMs: clock.now(),
    };

    const artifacts: ArtifactList = {};

    if (config.debug.trace && session) {
      const tracePath = resolve(debugDir, 'trace.zip');
      try {
        await session.stopTrace(tracePath);
        artifacts.trace = tracePath;
      } catch {
        // A trace that could not be written is an absent artefact, not a new failure.
      }
    }

    const failure = asRenderError(error, context, artifacts);

    // Diagnostics are captured *before* teardown, while the page is still open. Screenshotting
    // after the context closes silently yields no file — and "the artefact is missing" is
    // indistinguishable from "the artefact was not requested".
    const page = session?.page;
    if (page && !page.isClosed()) {
      await captureDiagnostics({
        page,
        config: config.debug,
        dir: debugDir,
        log,
        error: failure,
        manifest: manifestDocument('failed', failure),
        existing: artifacts,
      }).catch(() => undefined);
    } else {
      // Still worth writing the manifest and error file: "the browser died" is the failure, but
      // knowing what the script had done up to that point is exactly what the user needs.
      await captureDiagnostics({
        page: undefined,
        config: config.debug,
        dir: debugDir,
        log,
        error: failure,
        manifest: manifestDocument('failed', failure),
        existing: artifacts,
      }).catch(() => undefined);
    }

    await cleanup();

    // The output path must not hold anything that looks like a finished video.
    await rm(outputPath, { force: true });

    return new VideoRenderError(failure.message, failure.context, {
      ...(failure.hint ? { hint: failure.hint } : {}),
      ...(failure.cause !== undefined ? { cause: failure.cause } : {}),
      artifacts: failure.artifacts,
    });
  }

  /** Build the manifest document for the current run. */
  function manifestDocument(
    status: 'success' | 'failed',
    failure?: VideoRenderError,
  ): Record<string, unknown> {
    const sealed = timeline.seal();
    return {
      schemaVersion: 1,
      frameworkVersion: VERSION,
      status,
      startedAt: runStamp,
      seed: config.seed,
      fps: config.fps,
      width: config.viewport.output.width,
      height: config.viewport.output.height,
      layout: config.viewport.layout,
      layoutScale: config.layoutScale,
      recorder: {
        backend: config.recorder.backend,
        crf: config.recorder.crf,
        preset: config.recorder.preset,
      },
      browser: 'chromium',
      url: timeline.get('url') ?? null,
      durationMs: sealed.durationMs,
      // The manifest is a record of why two runs differed. Recording only the successful fields
      // would leave the interesting differences unrecorded.
      ...(status === 'failed' && failure
        ? { failure: { message: failure.message, hint: failure.hint, context: failure.context } }
        : {}),
      scenes: sealed.scenes.map((scene) => ({
        name: scene.name,
        index: scene.index,
        startMs: scene.startMs,
        endMs: scene.endMs,
        durationMs: scene.durationMs,
        metadata: scene.metadata,
        actions: scene.actions.map((action) => ({
          index: action.index,
          type: action.type,
          startMs: action.startMs,
          durationMs: action.durationMs,
          target: action.target ?? null,
          visibleText: action.visibleText ?? null,
        })),
      })),
      waits: clock.waits().map((wait) => ({
        startMs: wait.startMs,
        durationMs: wait.durationMs,
        reason: wait.reason,
      })),
    };
  }

  /**
   * Wrap every public operation so a failure gains context and diagnostics.
   *
   * Applied to the finished object rather than written into each method. The list of operations
   * that get this treatment is therefore stated in one place, which is the only way to be sure
   * the *next* action added also gets it — hand-wrapping nine methods is nine chances to forget.
   *
   * `dispose` is excluded: it runs during teardown, and reporting its failures would produce a
   * second, less interesting error on top of the real one.
   */
  function withFailureReporting(
    subject: Video,
    report: (error: unknown) => Promise<VideoRenderError>,
    /** True only for the outermost call; the cursor is nested, not recursive. */
    isTopLevel = true,
  ): Video {
    const skip = new Set<keyof Video>(['dispose', 'manifest']);
    const wrapped: Record<string, unknown> = {};

    for (const [name, value] of Object.entries(subject)) {
      if (typeof value !== 'function' || skip.has(name as keyof Video)) {
        wrapped[name] = value;
        continue;
      }

      wrapped[name] = async (...args: unknown[]): Promise<unknown> => {
        try {
          return await (value as (...callArgs: unknown[]) => Promise<unknown>).apply(subject, args);
        } catch (error) {
          throw await report(error);
        }
      };
    }

    // The cursor is a nested object of operations rather than an operation itself, so it is
    // wrapped as well — a failure inside `video.cursor.click()` must report just as well as one
    // inside `video.click()`. Only at the top level: recursing would look for a `cursor` on the
    // cursor, which does not exist.
    if (isTopLevel && 'cursor' in subject) {
      wrapped.cursor = withFailureReporting(subject.cursor as unknown as Video, report, false);
    }

    return wrapped as unknown as Video;
  }

  return withFailureReporting(video, reportFailure);
}

function absolute(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

/**
 * The highlight's opacity at a moment in logical time.
 *
 * Sampled per frame rather than driven by a CSS transition, so the fade is frame-exact: a 180ms
 * fade is 5.4 frames at 30fps and renders the same frames on any machine. A CSS transition
 * animates in wall-clock time inside the page and lands differently from run to run, which is the
 * determinism property the whole pipeline exists to provide.
 */
export function sampleHighlight(
  state: { fadeFromMs: number; fadeOutMs: number | null; options: { fadeMs: number } },
  atMs: number,
): number {
  const { fadeFromMs, fadeOutMs, options } = state;
  const fade = Math.max(1, options.fadeMs);

  const fadedIn = Math.min(1, Math.max(0, (atMs - fadeFromMs) / fade));

  if (fadeOutMs === null) return fadedIn;

  const fadedOut = Math.min(1, Math.max(0, (atMs - fadeOutMs) / fade));

  // A fade-out beginning before the fade-in finished multiplies rather than subtracts, so the ring
  // can never invert into a negative opacity and blink out.
  return fadedIn * (1 - fadedOut);
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
