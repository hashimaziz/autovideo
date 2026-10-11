/**
 * `autovideo inspect` — show what a script would do, without rendering.
 *
 * Runs the script against a recording object that records each operation and returns
 * immediately. No browser is launched and no frames are captured, so inspecting is fast and has
 * no side effects — which is what makes it useful for checking a script's structure, its scene
 * names, and its total planned duration.
 *
 * The recording object mirrors the real API exactly. That is the point: a script that runs under
 * inspect is a script whose calls are all real, so what it prints is what it would actually do.
 */

import type { HighlightOptions } from '../motion/highlight.js';
import { VIEWPORT_PRESETS, type VideoConfigInput } from '../config/config.js';

/** One recorded operation. */
export interface InspectedAction {
  index: number;
  type: string;
  scene: string | null;
  /** Logical milliseconds this operation would occupy. */
  durationMs: number;
  target: string | undefined;
}

/** What a recording of a script produced. */
export interface Inspection {
  video: unknown;
  actions: InspectedAction[];
}

const VIEWPORT_LABELS: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(VIEWPORT_PRESETS).map(([name, size]) => [name, `${size.width}x${size.height}`]),
  ),
};

/** Describe a viewport the way the user wrote it. */
function describeViewport(viewport: VideoConfigInput['viewport']): string {
  if (viewport === undefined) return 'vertical (1080x1920)';
  if (typeof viewport === 'string') {
    return viewport in VIEWPORT_LABELS ? `${viewport} (${VIEWPORT_LABELS[viewport]})` : viewport;
  }
  if ('width' in viewport && typeof viewport.width === 'number') {
    return `${viewport.width}x${'height' in viewport ? String(viewport.height) : '?'}`;
  }
  return JSON.stringify(viewport);
}

/**
 * Build a recording stand-in for the real API.
 *
 * Each method returns a resolved promise, so a script that awaits actions runs to completion in
 * microseconds rather than waiting on a browser.
 */
export function createInspectionRecorder(config: VideoConfigInput): Inspection {
  const actions: InspectedAction[] = [];
  let scene: string | null = null;
  let clock = 0;

  /**
   * Record one operation and return a promise for its result.
   *
   * `durationMs` is an *estimate*: a real run's timing depends on the page. Inspect is for
   * structure and ordering, not for predicting wall-clock output.
   */
  const record = (type: string, durationMs: number, target?: string): Promise<void> => {
    actions.push({ index: actions.length, type, scene, durationMs, target });
    clock += durationMs;
    return Promise.resolve();
  };

  const passthrough = async (): Promise<unknown> => undefined;

  const totalDuration = (): number => actions.reduce((sum, action) => sum + action.durationMs, 0);

  const video = {
    config: config,

    open: async (url: string): Promise<void> => record('open', 500, url),
    reload: (): Promise<void> => record('reload', 300),
    click: (selector: string): Promise<void> => record('click', 250, selector),
    doubleClick: (selector: string): Promise<void> => record('doubleClick', 350, selector),
    // Typing duration scales with the text, which is the one timing an estimate can get right.
    type: (selector: string, text: string): Promise<void> =>
      record('type', Math.max(80, text.length * 90), selector),
    fill: (selector: string): Promise<void> => record('fill', 120, selector),
    press: (selector: string | undefined, key: string): Promise<void> =>
      record('press', 150, `${selector ?? ''} ${key}`.trim()),
    hover: (selector: string): Promise<void> => record('hover', 200, selector),
    focus: (selector: string): Promise<void> => record('focus', 100, selector),
    select: (selector: string, value: string): Promise<void> =>
      record('select', 180, `${selector} = ${value}`),

    pause: (ms: number): Promise<void> => record('pause', ms),
    waitForSelector: (selector: string): Promise<void> => record('waitForSelector', 300, selector),
    waitForLoadState: (): Promise<void> => record('waitForLoadState', 200),

    cursor: {
      moveTo: (selector: string): Promise<void> => record('cursor.moveTo', 400, selector),
      moveToPoint: (x: number, y: number): Promise<void> =>
        record('cursor.moveToPoint', 400, `${x},${y}`),
      click: (): Promise<void> => record('cursor.click', 120),
      doubleClick: (): Promise<void> => record('cursor.doubleClick', 200),
      clickSelector: (selector: string): Promise<void> =>
        record('cursor.clickSelector', 520, selector),
      hide: (): Promise<void> => record('cursor.hide', 100),
      show: (): Promise<void> => record('cursor.show', 100),
      position: () => ({ x: 0, y: 0 }),
    },

    scroll: (options: { amount?: number } = {}): Promise<void> =>
      record('scroll', 500, String(options.amount ?? 600)),
    scrollTo: (selector: string): Promise<void> => record('scrollTo', 600, selector),

    // A highlight's own fade is invisible in an inspection, so it is reported at the duration of
    // the hold rather than its sub-second transitions.
    highlight: (selector: string, options: HighlightOptions = {}): Promise<void> =>
      record('highlight', options.durationMs ?? 300, selector),
    clearHighlight: (): Promise<void> => record('clearHighlight', 0),

    scene: async <T>(name: string, body: () => Promise<T>): Promise<T> => {
      const previous = scene;
      scene = name;
      actions.push({
        index: actions.length,
        type: 'scene',
        scene: name,
        durationMs: 0,
        target: name,
      });
      try {
        return await body();
      } finally {
        scene = previous;
      }
    },

    mark: (note: string, options: { selector?: string } = {}): void => {
      actions.push({
        index: actions.length,
        type: 'mark',
        scene,
        durationMs: 0,
        target: options.selector ?? note,
      });
    },

    export: async (destination?: string): Promise<Record<string, unknown>> => {
      // Mirrors the real return shape. A script that reads `result.path` must work under
      // inspect exactly as it does under render — otherwise the very scripts worth inspecting
      // are the ones that crash, which is precisely when inspect is most useful.
      const durationMs = totalDuration();
      return {
        path: destination ?? config.output ?? './output/video.mp4',
        frames: Math.round((durationMs / 1000) * (config.fps ?? 30)),
        durationMs,
        renderMs: 0,
        throughput: 0,
        estimated: true,
      };
    },
    dispose: passthrough,
    manifest: () => ({}),
    outputPath: config.output ?? './output/video.mp4',
  };

  return { video, actions };
}

/** Render an inspection for the terminal. */
export function printInspection(
  actions: readonly InspectedAction[],
  config: VideoConfigInput,
): void {
  const total = actions.reduce((sum, action) => sum + action.durationMs, 0);
  const fps = config.fps ?? 30;

  const lines: string[] = [];
  lines.push(
    `\n${actions.length} operations · ~${(total / 1000).toFixed(2)}s estimated · ${Math.round((total / 1000) * fps)} frames`,
  );
  lines.push(
    `viewport ${describeViewport(config.viewport)} · ${fps}fps · seed ${config.seed ?? 0}`,
  );
  lines.push('');

  for (const action of actions) {
    if (action.type === 'scene') {
      lines.push(`  ┌ ${action.target ?? 'scene'}`);
      continue;
    }
    const target = action.target ? ` ${truncate(action.target, 48)}` : '';
    const duration = action.durationMs > 0 ? `  ${String(action.durationMs).padStart(5)}ms` : '';
    lines.push(`  │ ${action.type}${target}${duration}`);
  }

  lines.push('');
  lines.push('  (durations are estimates — run `autovideo render` for the real thing)');
  lines.push('');

  process.stdout.write(lines.join('\n'));
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
