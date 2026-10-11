/**
 * Chromium lifecycle.
 *
 * Owns launching a browser configured for video capture rather than for testing: scrollbars
 * hidden, audio muted, background work not throttled, colour profile pinned, and a determinism
 * stylesheet installed on every navigation.
 *
 * Uses `browser.newContext()` rather than `launchPersistentContext()`. The reference
 * implementation needed a persistent profile purely because Google OAuth cannot be completed
 * unattended; Playwright's `storageState` covers the general authenticated case without handing
 * the framework a directory full of live session cookies (plan §22, §28).
 */

import {
  chromium,
  type Browser,
  type BrowserContext,
  type LaunchOptions,
  type Page,
} from 'playwright';

import type { VideoConfig } from '../config/config.js';
import { VideoBrowserError, messageOf } from '../runtime/errors.js';
import { hideAutomationFlags, installPageStyling } from './determinism.js';

/**
 * Chromium switches applied to every render.
 *
 * Each one is here for a reason that affects the *video*, not for tidiness:
 *
 * - `hide-scrollbars` — a scrollbar is chrome, and it changes width as the page scrolls.
 * - `mute-audio` — there is no audio track, and a stray autoplaying video could otherwise add
 *   an unwanted media element to the frame.
 * - `force-color-profile=srgb` — otherwise colours depend on the display profile of whichever
 *   machine rendered the video, which breaks pixel comparison between runs.
 * - the three `--disable-*-throttling` switches — **the important one.** Chromium throttles
 *   timers and rendering in windows it believes are backgrounded. A headless render window is
 *   routinely treated as one, and the symptom is `requestAnimationFrame` firing at a crawl,
 *   which stretches animations and makes a video unusable. Pinning these off is what keeps
 *   frame-for-frame timing on track.
 * - `disable-dev-shm-usage` — Docker's default 64MB /dev/shm makes Chromium crash under load.
 */
export const BASE_CHROMIUM_ARGS: readonly string[] = [
  '--hide-scrollbars',
  '--mute-audio',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate,MediaRouter',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--force-color-profile=srgb',
  '--disable-dev-shm-usage',
];

/**
 * Assemble the launch options.
 *
 * Exported and pure so the argument list can be unit-tested without a browser. The single
 * `args` array is the whole point: the reference implementation spread a stealth `args` and
 * then declared a second `args` later in the same object literal, so the later key silently won
 * and its own stealth flags were discarded. One array, built once, cannot have that bug.
 */
export function buildLaunchOptions(config: VideoConfig): LaunchOptions {
  const args = [...BASE_CHROMIUM_ARGS, ...config.browser.args];

  if (config.browser.hideAutomationFlags) {
    args.push('--disable-blink-features=AutomationControlled');
  }

  return {
    headless: config.browser.headless,
    ...(config.browser.executablePath ? { executablePath: config.browser.executablePath } : {}),
    // Google's sign-in refuses Chrome for Testing on the automation flag alone, which is what
    // these two lines remove. Only applied when explicitly requested.
    ...(config.browser.hideAutomationFlags ? { ignoreDefaultArgs: ['--enable-automation'] } : {}),
    args,
  };
}

/**
 * Assemble the browser-context options.
 *
 * Keys are omitted rather than set to `undefined` where the config allows `null`, because
 * `exactOptionalPropertyTypes` treats an explicit `undefined` as a type error, and because an
 * absent key reads more clearly in a Playwright trace than a present-but-empty one.
 */
export function buildContextOptions(config: VideoConfig) {
  return {
    // The CSS layout size, not the output size. See ARCHITECTURE_AUDIT.md §4.1.
    viewport: config.viewport.layout,
    deviceScaleFactor: 1,
    ...(config.browser.reducedMotion ? { reducedMotion: config.browser.reducedMotion } : {}),
    ...(config.browser.colorScheme ? { colorScheme: config.browser.colorScheme } : {}),
    ignoreHTTPSErrors: true,
    acceptDownloads: false,
    ...(config.browser.storageState ? { storageState: config.browser.storageState } : {}),
  };
}

/** A launched browser, its context, and the page the video is recorded from. */
export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Begin recording a Playwright trace. Safe to call once. */
  startTrace(): Promise<void>;
  /** Finish the trace and write it to `destination`. No-op if tracing was never started. */
  stopTrace(destination: string): Promise<void>;
  /**
   * Flush the built-in screencast to `destination` and close the context.
   *
   * The ordering is load-bearing. `saveAs` registers a callback that resolves only once the
   * capture finishes, and the capture finishes when the context closes — so the call has to be
   * started first, the context closed second, and the promise awaited last. Awaiting before
   * closing deadlocks; calling after close fails with "Target page, context or browser has been
   * closed".
   *
   * Closes the context, so the session is unusable afterwards.
   */
  saveScreencast(destination: string): Promise<void>;
  /** Close the context and the browser. Idempotent. */
  close(): Promise<void>;
}

/**
 * Launch Chromium and prepare a page for recording.
 *
 * @throws {VideoBrowserError} if Chromium is not installed or fails to start. The error names
 *   the fix, because "browserType.launch: Executable doesn't exist" is not self-explanatory.
 */
/** Extra per-launch behaviour the recorder backends need. */
export interface SessionExtras {
  /**
   * Enable Playwright's built-in screencast.
   *
   * `size` must equal the viewport: the screencast only ever scales *down*, so asking for a
   * larger capture produces grey padding rather than an enlargement. Verified in
   * `research/probes/screencast-sizing/`.
   */
  recordVideo?: { dir: string; size: { width: number; height: number } };
}

export async function launchBrowser(
  config: VideoConfig,
  extras: SessionExtras = {},
): Promise<BrowserSession> {
  let browser: Browser;
  try {
    browser = await chromium.launch(buildLaunchOptions(config));
  } catch (error) {
    throw new VideoBrowserError(`Could not launch Chromium: ${messageOf(error)}`, {
      hint: 'Run `npx playwright install chromium`. If a custom browser is configured, check browser.executablePath.',
      cause: error,
    });
  }

  const context = await browser.newContext({
    ...buildContextOptions(config),
    ...(extras.recordVideo ? { recordVideo: extras.recordVideo } : {}),
  });
  const page = context.pages()[0] ?? (await context.newPage());

  page.setDefaultTimeout(config.timeouts.action);
  page.setDefaultNavigationTimeout(config.timeouts.navigation);

  if (config.browser.hideAutomationFlags) {
    await hideAutomationFlags(page);
  }
  installPageStyling(page, { extraCss: config.browser.extraCss });

  let tracing = false;
  let closed = false;

  return {
    browser,
    context,
    page,

    async startTrace(): Promise<void> {
      if (tracing) return;
      // Screenshots and DOM snapshots are what make a trace worth keeping; sources are cheap
      // by comparison and are what let the trace viewer show real code.
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      tracing = true;
    },

    async stopTrace(destination: string): Promise<void> {
      if (!tracing) return;
      tracing = false;
      // Must complete before the context closes — stopping after teardown fails with
      // "Target page, context or browser has been closed" and loses the entire trace.
      await context.tracing.stop({ path: destination });
    },

    async saveScreencast(destination: string): Promise<void> {
      const capture = page.video();
      if (!capture) {
        await context.close().catch(() => undefined);
        throw new VideoBrowserError('Playwright produced no screencast for this page.', {
          hint: 'Check that the session was launched with recordVideo enabled.',
        });
      }

      const saving = capture.saveAs(destination);
      closed = true;
      await context.close();
      await saving;
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    },
  };
}

/**
 * Fail fast when the target is not running.
 *
 * Playwright's own error for an unreachable server is a connection-refused traceback that does
 * not mention the app. This runs *before* a browser is launched, so the failure costs
 * milliseconds instead of a minute of recorded navigation.
 */
export async function assertAppReachable(url: string, timeoutMs = 10_000): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new VideoBrowserError(`Could not reach ${url}: ${messageOf(error)}`, {
      hint: 'Start the application first, or point `video.open()` at the right URL.',
      cause: error,
    });
  }

  if (response.status >= 500) {
    throw new VideoBrowserError(`${url} responded with HTTP ${response.status}.`, {
      hint: 'The app is running but erroring — check its terminal output.',
    });
  }
}
