/**
 * Browser actions.
 *
 * The verbs a video script is written in. Each is thin: perform the Playwright call, then
 * translate its failure into an error that names the selector and suggests a next step.
 *
 * Actions deliberately do **not** hide their own waits. Every one resolves when the browser says
 * the thing happened, not after an arbitrary sleep. Pacing is a separate, explicit concept
 * (`pause`), because a fixed sleep used as a wait is indistinguishable from a fixed sleep used as
 * a pause, and only one of those is correct.
 *
 * They are exposed through a factory rather than as free functions so the timeout and page have
 * exactly one source of truth. Playwright exposes no way to *read* the default timeout back, so
 * threading it explicitly is the only honest option.
 */

import type { Locator, Page } from 'playwright';

import { VideoActionError, messageOf } from '../runtime/errors.js';
import {
  applyScrollOffset,
  centringOffsetFromMeasurement,
  measureElementScript,
  readScrollMetrics,
  resolveScrollTarget,
  type RawMeasurement,
  type ScrollTarget,
} from './scrolling.js';

/** State an element can be waited for. */
export type WaitState = 'attached' | 'detached' | 'visible' | 'hidden';

export interface ActionsContext {
  page: Page;
  /** Per-action timeout in milliseconds. */
  timeout: number;
  /** Per-navigation timeout in milliseconds. */
  navigationTimeout: number;
}

/** Everything a video script can ask the browser to do. */
export interface Actions {
  open(url: string): Promise<void>;
  reload(): Promise<void>;
  click(selector: string, options?: { clickCount?: number }): Promise<void>;
  doubleClick(selector: string): Promise<void>;
  type(
    selector: string,
    text: string,
    options?: { delayMs?: number; clear?: boolean },
  ): Promise<void>;
  fill(selector: string, text: string): Promise<void>;
  press(selector: string | undefined, key: string): Promise<void>;
  hover(selector: string): Promise<void>;
  focus(selector: string): Promise<void>;
  select(selector: string, value: string): Promise<void>;
  waitForSelector(
    selector: string,
    options?: { state?: WaitState; timeoutMs?: number },
  ): Promise<void>;
  waitForLoadState(
    state?: 'load' | 'domcontentloaded' | 'networkidle',
    timeoutMs?: number,
  ): Promise<void>;
  /** Current scroll offset of whichever element actually scrolls. */
  scrollPosition(): Promise<number>;
  /** Scroll to an absolute offset immediately. Animated scrolling goes through the motion track. */
  scrollToOffset(
    offsetY: number,
    target?: ScrollTarget,
  ): Promise<{
    from: number;
    to: number;
    target: ScrollTarget;
  }>;
  /** The offset that would centre an element, or null if it could not be measured. */
  offsetToCentre(selector: string): Promise<number | null>;
}

function describe(selector: string): string {
  return selector.length > 120 ? `${selector.slice(0, 117)}...` : selector;
}

/**
 * Resolve a selector to a locator, rejecting an empty one immediately.
 *
 * Playwright's own "waiting for locator(...)" message is long and buries the useful part.
 */
function locate(page: Page, selector: string, action: string): Locator {
  if (typeof selector !== 'string' || selector.trim().length === 0) {
    throw new VideoActionError(`${action} requires a non-empty selector.`);
  }
  return page.locator(selector);
}

/** Build the action set for one page. */
export function createActions(context: ActionsContext): Actions {
  const { page, timeout, navigationTimeout } = context;

  /** Wrap a Playwright call so failures name the selector and the action. */
  async function attempt<T>(
    action: string,
    target: string,
    body: () => Promise<T>,
    hint?: string,
  ): Promise<T> {
    try {
      return await body();
    } catch (error) {
      // An error we raised ourselves (e.g. a visibility check) is already specific; re-wrapping
      // it would bury the original under a generic Playwright timeout.
      if (error instanceof VideoActionError) throw error;

      throw new VideoActionError(`${action} failed for ${describe(target)}: ${messageOf(error)}`, {
        ...(hint ? { hint } : {}),
        cause: error,
      });
    }
  }

  const actions: Actions = {
    async open(url: string): Promise<void> {
      await attempt(
        'open',
        url,
        async () => {
          await page.goto(url, { waitUntil: 'load', timeout: navigationTimeout });
        },
        'Is the application running? Use `autovideo doctor` to check reachability.',
      );
    },

    async reload(): Promise<void> {
      await attempt('reload', 'the current page', async () => {
        await page.reload({ waitUntil: 'load', timeout: navigationTimeout });
      });
    },

    async click(selector, options = {}): Promise<void> {
      const locator = locate(page, selector, 'click');

      // Visibility is checked first so a click on something offscreen reports *that*, rather
      // than Playwright's "element is outside of the viewport", which reads like a bug.
      if (!(await locator.isVisible().catch(() => false))) {
        throw new VideoActionError(`Tried to click ${describe(selector)}, which is not visible.`, {
          hint: 'It may be below the fold, behind an overlay, or not rendered yet. Await waitForSelector first.',
        });
      }

      await attempt(
        'click',
        selector,
        async () => {
          await locator.click({ timeout, clickCount: options.clickCount ?? 1 });
        },
        'The element may be covered by another element, or may have detached mid-click.',
      );
    },

    async doubleClick(selector: string): Promise<void> {
      await actions.click(selector, { clickCount: 2 });
    },

    async type(selector, text, options = {}): Promise<void> {
      const locator = locate(page, selector, 'type');

      if (!(await locator.isVisible().catch(() => false))) {
        throw new VideoActionError(
          `Tried to type into ${describe(selector)}, which is not visible.`,
          { hint: 'Click or focus the field first, or await waitForSelector.' },
        );
      }

      await attempt(
        'type',
        selector,
        async () => {
          if (options.clear !== false) await locator.fill('');
          // Types character by character rather than filling, because the point of a video is to
          // watch the text appear. `fill()` would set the value instantly and show nothing.
          await locator.pressSequentially(text, { delay: options.delayMs ?? 40, timeout });
        },
        'The field may be readonly, disabled, or replaced while typing.',
      );
    },

    async fill(selector: string, text: string): Promise<void> {
      const locator = locate(page, selector, 'fill');
      await attempt('fill', selector, async () => {
        await locator.fill(text, { timeout });
      });
    },

    async press(selector: string | undefined, key: string): Promise<void> {
      const target = selector ?? 'the focused element';
      await attempt('press', target, async () => {
        if (selector) {
          await locate(page, selector, 'press').press(key, { timeout });
          return;
        }
        await page.keyboard.press(key);
      });
    },

    async hover(selector: string): Promise<void> {
      const locator = locate(page, selector, 'hover');
      await attempt('hover', selector, async () => {
        await locator.hover({ timeout });
      });
    },

    async focus(selector: string): Promise<void> {
      const locator = locate(page, selector, 'focus');
      await attempt('focus', selector, async () => {
        await locator.focus({ timeout });
      });
    },

    async select(selector: string, value: string): Promise<void> {
      const locator = locate(page, selector, 'select');

      try {
        await locator.selectOption(value, { timeout });
      } catch (error) {
        if (error instanceof VideoActionError) throw error;
        throw new VideoActionError(
          `Could not select "${value}" in ${describe(selector)}: ${messageOf(error)}`,
          {
            hint: `Check the option exists. Available: ${await readOptions(locator)}.`,
            cause: error,
          },
        );
      }
    },

    async waitForSelector(selector, options = {}): Promise<void> {
      const state = options.state ?? 'visible';
      const waitTimeout = options.timeoutMs ?? timeout;

      try {
        await page.locator(selector).waitFor({ state, timeout: waitTimeout });
      } catch (error) {
        throw new VideoActionError(
          `Selector ${describe(selector)} did not reach state "${state}" within ${waitTimeout}ms.`,
          {
            hint: 'The element may never appear. Check the selector, and whether the page finished loading.',
            cause: error,
          },
        );
      }
    },

    async waitForLoadState(state = 'load', timeoutMs = navigationTimeout): Promise<void> {
      try {
        await page.waitForLoadState(state, { timeout: timeoutMs });
      } catch (error) {
        throw new VideoActionError(`Page never reached "${state}".`, {
          hint: 'The page may be waiting on a request that never completes. A long-polling connection will also prevent "networkidle".',
          cause: error,
        });
      }
    },

    async scrollPosition(): Promise<number> {
      const evaluate = (script: string): Promise<unknown> => page.evaluate(script);
      const target = await resolveScrollTarget(evaluate);
      return (await readScrollMetrics(evaluate, target)).offset;
    },

    async scrollToOffset(offsetY: number, target?: ScrollTarget) {
      const evaluate = (script: string): Promise<unknown> => page.evaluate(script);
      const resolved = target ?? (await resolveScrollTarget(evaluate));
      const before = await readScrollMetrics(evaluate, resolved);

      // Clamped: asking to scroll past the end of a document must land on its end, not
      // overshoot into nothing.
      const to = Math.max(0, Math.min(Math.round(offsetY), before.limit));
      await applyScrollOffset(evaluate, resolved, to);

      return { from: before.offset, to, target: resolved };
    },

    async offsetToCentre(selector: string): Promise<number | null> {
      const measurement = (await page
        .evaluate(measureElementScript(selector))
        .catch(() => null)) as RawMeasurement | null;

      if (!measurement) return null;
      return centringOffsetFromMeasurement(measurement);
    },
  };

  return actions;
}

/**
 * List a `<select>`'s option values.
 *
 * Read through plain locator APIs rather than a page-side script. `evaluateAll` with a string
 * does not invoke it — it evaluates the string as an expression, so a bare arrow yields a
 * function object and the caller silently receives nothing. Using `getAttribute` avoids the
 * question entirely and keeps `src/` free of DOM types.
 */
async function readOptions(locator: Locator): Promise<string> {
  const count = await locator
    .locator('option')
    .count()
    .catch(() => 0);
  if (count === 0) return 'none readable';

  const values: string[] = [];
  for (let index = 0; index < count; index++) {
    const value = await locator
      .locator('option')
      .nth(index)
      .getAttribute('value')
      .catch(() => null);
    if (value !== null) values.push(value);
  }

  return values.length > 0 ? values.join(', ') : 'none readable';
}
