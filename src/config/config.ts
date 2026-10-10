/**
 * Configuration: the complete, validated input to a render.
 *
 * Everything that can change a video's output lives here, and every field ends up in the run
 * manifest. That is the point: a manifest that cannot explain why two runs differed is not a
 * reproducibility record, it is a log (plan §18).
 *
 * Defaults are chosen so that `createVideo({})` produces a sane vertical product video, and so
 * that `video render script.ts` works with no configuration at all.
 */

import {
  resolveViewport,
  VideoConfigError,
  type ResolvedViewport,
  type ViewportInput,
} from './viewport.js';

export {
  resolveViewport,
  VideoConfigError,
  VIEWPORT_PRESETS,
  VIEWPORT_PRESET_NAMES,
} from './viewport.js';
export type {
  AspectRatio,
  ResolvedViewport,
  Size,
  ViewportInput,
  ViewportPreset,
} from './viewport.js';

/** Recording backend. */
export type RecorderBackend =
  /**
   * Logical-clock frame pipeline (default). Deterministic, draws the cursor, and renders faster
   * than real time at typical frame rates. Chosen because Playwright's screencast does neither
   * of the first two — see ARCHITECTURE_AUDIT.md §5.
   */
  | 'frames'
  /**
   * Playwright's built-in wall-clock screencast. Faster to set up and roughly real-time, but the
   * frame timing is not reproducible and no cursor is drawn. For throwaway previews only.
   */
  | 'screencast';

/** How the video cursor is represented. */
export type CursorMode =
  /**
   * Framework-rendered overlay composited into the captured page (default). Fully controlled,
   * consistent across machines, supports click emphasis.
   */
  | 'overlay'
  /** Drive the real browser mouse and draw a minimal in-page cursor at its position. */
  | 'native';

/** Pacing vocabulary, in milliseconds. */
export interface TimingConfig {
  /** Very short beat — cursor arrival, a checkbox toggle. */
  settle: number;
  /** One idea on screen. */
  short: number;
  /** A reading needs to be legible. */
  normal: number;
  /** The viewer needs time to absorb a chart. */
  long: number;
}

/** Per-action and per-navigation timeouts, in milliseconds. */
export interface TimeoutConfig {
  action: number;
  navigation: number;
}

/** Cursor appearance and motion. */
export interface CursorConfig {
  mode: CursorMode;
  /** Whether the cursor is drawn at all until the script moves it. */
  visible: boolean;
  /** Seconds a click ripple remains visible. */
  clickRippleMs: number;
  /** Whether the ripple animates on click. Purely visual emphasis. */
  clickEmphasis: boolean;
}

/** What the browser should do. */
export interface BrowserConfig {
  /** `false` opens a real window. Useful when debugging a script. */
  headless: boolean;
  /** Chromium executable. Defaults to the Playwright-managed build. */
  executablePath: string | undefined;
  /**
   * Playwright `storageState` file for authenticated apps (plan §22).
   *
   * Never recorded in the manifest and never copied into diagnostics — it carries session
   * cookies. The path is recorded; the contents are never read by the framework.
   */
  storageState: string | undefined;
  /** Extra Chromium command-line switches, merged with (not replacing) the framework's own. */
  args: string[];
  /**
   * Extra CSS injected into every recorded page.
   *
   * The supported redaction hook. Hide account emails, personal modules, or anything else that
   * must not appear in a published video, without the engine carrying app-specific selectors.
   */
  extraCss: string[];
  /** Colour scheme forced on the page. `null` leaves the browser default. */
  colorScheme: 'dark' | 'light' | null;
  /** Ask the browser to reduce motion. Kept on: the framework animates deliberately. */
  reducedMotion: 'reduce' | null;
  /**
   * Remove the `navigator.webdriver` marker.
   *
   * Needed only for targets that reject automated browsers outright. Documented in the README as
   * a deliberate fingerprint-reduction option rather than enabled by default.
   */
  hideAutomationFlags: boolean;
}

/** Encoding and output. */
export interface RecorderConfig {
  backend: RecorderBackend;
  /** Frame format on the ffmpeg pipe. `jpeg` encodes faster; `png` is lossless for goldens. */
  frameFormat: 'jpeg' | 'png';
  /** JPEG quality, 1-100. Ignored for PNG. */
  frameQuality: number;
  /** H.264 constant-rate factor. Lower is better quality and a bigger file. */
  crf: number;
  /** x264 preset. `slow`/`slower` compress better; `veryfast` renders quicker. */
  preset: 'ultrafast' | 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow' | 'slower';
  /** Move the MP4 index to the front so it plays before fully downloaded. */
  fastStart: boolean;
  /** Explicit ffmpeg binary. Defaults to the bundled `ffmpeg-static` build. */
  ffmpegPath: string | undefined;
}

/** Debugging artefact capture. */
export interface DebugConfig {
  /** Screenshot on failure. */
  screenshot: boolean;
  /** Playwright trace (`trace.zip`) on failure. Openable in the trace viewer. */
  trace: boolean;
  /** Record console messages to `console.log` on failure. */
  console: boolean;
  /** Record network requests to `network.log` on failure. */
  network: boolean;
  /** Dump every raw frame on failure. Useful, and enormous. */
  frames: boolean;
  /** Directory for diagnostics. Relative paths resolve against `outputDir`. */
  dir: string;
}

/** Public configuration surface. */
export interface VideoConfigInput {
  /** Output shape. Accepts a preset name, explicit size, aspect ratio, or `"1080x1920"`. */
  viewport?: ViewportInput;
  /** Output frames per second. */
  fps?: number;
  /** Seed for every piece of randomised motion. The same seed reproduces the same video. */
  seed?: number;
  /**
   * How much larger everything appears than it would at 1:1.
   *
   * The page lays out at `output / layoutScale` CSS pixels and the encoder enlarges back to
   * `output`. 2 is the default: at 1:1 a dense dashboard renders text around 1.3% of frame
   * width, which is unreadable on a phone. Must divide both output dimensions into whole,
   * even numbers.
   */
  layoutScale?: number;
  /** Where the video is written. `export()` may override this. */
  output?: string;
  /** Root directory for run artefacts. */
  outputDir?: string;
  browser?: Partial<BrowserConfig>;
  recorder?: Partial<RecorderConfig>;
  cursor?: Partial<CursorConfig>;
  debug?: Partial<DebugConfig>;
  timeouts?: Partial<TimeoutConfig>;
  timing?: Partial<TimingConfig>;
  /** Check the target URL responds before launching Chromium. */
  preflight?: boolean;
}

/** Fully-resolved configuration. Every field is concrete; nothing is optional. */
export interface VideoConfig {
  viewport: ResolvedViewport;
  fps: number;
  seed: number;
  layoutScale: number;
  output: string;
  outputDir: string;
  browser: BrowserConfig;
  recorder: RecorderConfig;
  cursor: CursorConfig;
  debug: DebugConfig;
  timeouts: TimeoutConfig;
  timing: TimingConfig;
  preflight: boolean;
}

/** Defaults. Chosen so `createVideo({})` produces a publishable vertical video. */
export const DEFAULT_CONFIG = {
  fps: 30,
  seed: 0,
  layoutScale: 2,
  output: './output/video.mp4',
  outputDir: './output',
  preflight: true,
  browser: {
    headless: true,
    executablePath: undefined,
    storageState: undefined,
    args: [],
    extraCss: [],
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    hideAutomationFlags: false,
  },
  recorder: {
    backend: 'frames',
    frameFormat: 'jpeg',
    frameQuality: 90,
    crf: 20,
    preset: 'slow',
    fastStart: true,
    ffmpegPath: undefined,
  },
  cursor: {
    mode: 'overlay',
    visible: true,
    clickRippleMs: 260,
    clickEmphasis: true,
  },
  debug: {
    screenshot: true,
    trace: true,
    console: true,
    network: true,
    frames: false,
    dir: 'debug',
  },
  timeouts: {
    action: 20_000,
    navigation: 45_000,
  },
  timing: {
    settle: 400,
    short: 600,
    normal: 1300,
    long: 2200,
  },
} as const satisfies Omit<VideoConfig, 'viewport'>;

/**
 * Validate and normalise caller configuration.
 *
 * @throws {VideoConfigError} with a hint for every rejected value. Failures here are cheap;
 * the same mistake discovered after a browser launch and a minute of recording is not.
 */
export function resolveConfig(input: VideoConfigInput = {}): VideoConfig {
  const fps = requireInteger(input.fps ?? DEFAULT_CONFIG.fps, 'fps', 1, 240);
  const seed = requireInteger(input.seed ?? DEFAULT_CONFIG.seed, 'seed', -(2 ** 53), 2 ** 53);
  const layoutScale = requireInteger(
    input.layoutScale ?? DEFAULT_CONFIG.layoutScale,
    'layoutScale',
    1,
    4,
  );

  const viewport = resolveViewport(input.viewport ?? 'vertical', layoutScale);

  return {
    viewport,
    fps,
    seed,
    layoutScale,
    output: requireNonEmptyString(input.output ?? DEFAULT_CONFIG.output, 'output'),
    outputDir: requireNonEmptyString(input.outputDir ?? DEFAULT_CONFIG.outputDir, 'outputDir'),
    preflight: requireBoolean(input.preflight ?? DEFAULT_CONFIG.preflight, 'preflight'),
    browser: {
      headless: requireBoolean(
        input.browser?.headless ?? DEFAULT_CONFIG.browser.headless,
        'browser.headless',
      ),
      executablePath: optionalString(input.browser?.executablePath, 'browser.executablePath'),
      storageState: optionalString(input.browser?.storageState, 'browser.storageState'),
      args: requireStringArray(input.browser?.args ?? [], 'browser.args'),
      extraCss: requireStringArray(input.browser?.extraCss ?? [], 'browser.extraCss'),
      colorScheme: requireEnum(
        input.browser?.colorScheme ?? DEFAULT_CONFIG.browser.colorScheme,
        ['dark', 'light', null],
        'browser.colorScheme',
      ),
      reducedMotion: requireEnum(
        input.browser?.reducedMotion ?? DEFAULT_CONFIG.browser.reducedMotion,
        ['reduce', null],
        'browser.reducedMotion',
      ),
      hideAutomationFlags: requireBoolean(
        input.browser?.hideAutomationFlags ?? DEFAULT_CONFIG.browser.hideAutomationFlags,
        'browser.hideAutomationFlags',
      ),
    },
    recorder: {
      backend: requireEnum(
        input.recorder?.backend ?? DEFAULT_CONFIG.recorder.backend,
        ['frames', 'screencast'],
        'recorder.backend',
      ),
      frameFormat: requireEnum(
        input.recorder?.frameFormat ?? DEFAULT_CONFIG.recorder.frameFormat,
        ['jpeg', 'png'],
        'recorder.frameFormat',
      ),
      frameQuality: requireInteger(
        input.recorder?.frameQuality ?? DEFAULT_CONFIG.recorder.frameQuality,
        'recorder.frameQuality',
        1,
        100,
      ),
      crf: requireInteger(
        input.recorder?.crf ?? DEFAULT_CONFIG.recorder.crf,
        'recorder.crf',
        0,
        51,
      ),
      preset: requireEnum(
        input.recorder?.preset ?? DEFAULT_CONFIG.recorder.preset,
        ['ultrafast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower'],
        'recorder.preset',
      ),
      fastStart: requireBoolean(
        input.recorder?.fastStart ?? DEFAULT_CONFIG.recorder.fastStart,
        'recorder.fastStart',
      ),
      ffmpegPath: optionalString(input.recorder?.ffmpegPath, 'recorder.ffmpegPath'),
    },
    cursor: {
      mode: requireEnum(
        input.cursor?.mode ?? DEFAULT_CONFIG.cursor.mode,
        ['overlay', 'native'],
        'cursor.mode',
      ),
      visible: requireBoolean(
        input.cursor?.visible ?? DEFAULT_CONFIG.cursor.visible,
        'cursor.visible',
      ),
      clickRippleMs: requireInteger(
        input.cursor?.clickRippleMs ?? DEFAULT_CONFIG.cursor.clickRippleMs,
        'cursor.clickRippleMs',
        0,
        5000,
      ),
      clickEmphasis: requireBoolean(
        input.cursor?.clickEmphasis ?? DEFAULT_CONFIG.cursor.clickEmphasis,
        'cursor.clickEmphasis',
      ),
    },
    debug: {
      screenshot: requireBoolean(
        input.debug?.screenshot ?? DEFAULT_CONFIG.debug.screenshot,
        'debug.screenshot',
      ),
      trace: requireBoolean(input.debug?.trace ?? DEFAULT_CONFIG.debug.trace, 'debug.trace'),
      console: requireBoolean(
        input.debug?.console ?? DEFAULT_CONFIG.debug.console,
        'debug.console',
      ),
      network: requireBoolean(
        input.debug?.network ?? DEFAULT_CONFIG.debug.network,
        'debug.network',
      ),
      frames: requireBoolean(input.debug?.frames ?? DEFAULT_CONFIG.debug.frames, 'debug.frames'),
      dir: requireNonEmptyString(input.debug?.dir ?? DEFAULT_CONFIG.debug.dir, 'debug.dir'),
    },
    timeouts: {
      action: requireInteger(
        input.timeouts?.action ?? DEFAULT_CONFIG.timeouts.action,
        'timeouts.action',
        1,
        600_000,
      ),
      navigation: requireInteger(
        input.timeouts?.navigation ?? DEFAULT_CONFIG.timeouts.navigation,
        'timeouts.navigation',
        1,
        600_000,
      ),
    },
    timing: {
      settle: requireDuration(
        input.timing?.settle ?? DEFAULT_CONFIG.timing.settle,
        'timing.settle',
      ),
      short: requireDuration(input.timing?.short ?? DEFAULT_CONFIG.timing.short, 'timing.short'),
      normal: requireDuration(
        input.timing?.normal ?? DEFAULT_CONFIG.timing.normal,
        'timing.normal',
      ),
      long: requireDuration(input.timing?.long ?? DEFAULT_CONFIG.timing.long, 'timing.long'),
    },
  };
}

/** Total frames for a given duration. The single place this conversion happens. */
export function framesFor(durationMs: number, fps: number): number {
  return Math.max(1, Math.round((durationMs / 1000) * fps));
}

/** Logical timestamp (ms) at which a given frame index is presented. */
export function timeForFrame(frameIndex: number, fps: number): number {
  return (frameIndex / fps) * 1000;
}

/* -------------------------------------------------------------------------------------------- */
/* Validation helpers                                                                           */
/*                                                                                               */
/* Each one throws a VideoConfigError naming the exact field and the permitted values. A config  */
/* error that says "invalid input" costs a debugging session; one that says "`fps` must be an   */
/* integer between 1 and 240 (got 0)" does not.                                                 */
/* -------------------------------------------------------------------------------------------- */

function requireInteger(value: number, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new VideoConfigError(`${field} must be a finite number (got ${String(value)}).`);
  }
  if (!Number.isInteger(value)) {
    throw new VideoConfigError(`${field} must be an integer (got ${value}).`);
  }
  if (value < min || value > max) {
    throw new VideoConfigError(`${field} must be between ${min} and ${max} (got ${value}).`);
  }
  return value;
}

/** A non-negative whole number of milliseconds. Negative delays would move logical time backwards. */
function requireDuration(value: number, field: string): number {
  const resolved = requireInteger(value, field, 0, 600_000);
  return resolved;
}

function requireBoolean(value: boolean, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new VideoConfigError(`${field} must be a boolean (got ${String(value)}).`);
  }
  return value;
}

function requireNonEmptyString(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new VideoConfigError(`${field} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireNonEmptyString(value, field);
}

function requireStringArray(value: string[], field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new VideoConfigError(`${field} must be an array of strings.`);
  }
  return [...value];
}

function requireEnum<T extends string | null>(value: T, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value)) {
    throw new VideoConfigError(
      `${field} must be one of: ${allowed.map((entry) => JSON.stringify(entry)).join(', ')} (got ${JSON.stringify(value)}).`,
    );
  }
  return value;
}
