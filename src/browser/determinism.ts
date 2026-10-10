/**
 * Injected page styling: what makes two runs of the same script produce the same pixels.
 *
 * Two independent concerns, both applied on every navigation:
 *
 * 1. **Determinism.** CSS animations, transitions and the text caret all run off the wall clock
 *    or off a compositor clock, so they differ between two runs of an identical script. So are
 *    smooth scrolling and `:focus-visible` rings. All are suppressed.
 *
 * 2. **Redaction.** Anything the caller passes in `browser.extraCss`. The framework deliberately
 *    ships *no* app-specific selectors here — the reference implementation hardcoded
 *    `.user-email` and two `data-testid` values, which made the engine un-reusable. Hiding a
 *    personal module is configuration, not engine code.
 *
 * This is a recording-time overlay only. No application code changes and no user settings are
 * mutated, so none of it can leak into the real product.
 */

import type { Page } from 'playwright';

/**
 * Marks elements the framework itself injects.
 *
 * The determinism rules below apply to everything *except* these, because the cursor overlay is
 * positioned by the framework on every frame and must not be frozen by a blanket
 * `transition-duration: 0s`.
 */
const FRAMEWORK_ATTRIBUTE = 'data-autovideo';

const DETERMINISM_CSS = `
  /* Everything except the framework's own overlay. */
  *:not([${FRAMEWORK_ATTRIBUTE}]),
  *:not([${FRAMEWORK_ATTRIBUTE}])::before,
  *:not([${FRAMEWORK_ATTRIBUTE}])::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }

  /*
   * The caret blinks on its own timer. It is the most obvious source of pixel-level
   * nondeterminism in a typed video, and it is also invisible in most social players.
   */
  *:not([${FRAMEWORK_ATTRIBUTE}]) {
    caret-color: transparent !important;
  }

  /*
   * Smooth scrolling is driven here, frame by frame. If the page were also allowed to animate
   * its own scrolling, the two would fight and the scroll would land somewhere neither chose.
   */
  html {
    scroll-behavior: auto !important;
  }

  /* Clicks should read as deliberate, not as tab navigation. */
  :focus-visible {
    outline: none !important;
  }
`;

export interface PageStylingOptions {
  /** Redaction and app-specific rules, from `browser.extraCss`. */
  extraCss?: readonly string[];
}

/** The combined stylesheet. Exported for testing and for the `doctor` command. */
export function buildStyling(options: PageStylingOptions = {}): string {
  const extra = (options.extraCss ?? []).filter((css) => css.trim().length > 0);
  return [DETERMINISM_CSS, ...extra].join('\n');
}

/**
 * Attach the styling to a page and re-apply it after every navigation.
 *
 * Deliberately **not** memoised. A module-level "already applied" cache is the obvious
 * optimisation and it is wrong: the reference implementation had exactly that bug, where a
 * pre-flight page claimed the stylesheet and the recording page silently rendered without it.
 * The cost of re-adding a style tag is negligible; the cost of the bug is a video full of
 * blinking carets that nobody can explain.
 */
export function installPageStyling(page: Page, options: PageStylingOptions = {}): void {
  const css = buildStyling(options);

  const apply = (): void => {
    // A navigation can race the tag insertion; the catch is deliberate because a failed style
    // injection must not abort the run, and the next navigation will try again.
    void page.addStyleTag({ content: css }).catch(() => undefined);
  };

  apply();
  page.on('domcontentloaded', apply);
  page.on('load', apply);
}

/**
 * Remove the `navigator.webdriver` marker.
 *
 * Only needed for targets that reject automated browsers outright. Applied both as an init
 * script (for later navigations) and immediately, because an init script registered after a
 * page has already loaded never fires.
 *
 * NOTE: passed to the browser as a **string**, never as a function. The TypeScript runner
 * rewrites named functions with a `__name` helper that does not exist in the page, so they throw
 * — and for init scripts they throw *silently*, leaving the marker in place while every caller
 * believes it was removed. This constraint is enforced by a unit test on the exported constant.
 */
export const HIDE_AUTOMATION_FLAGS_SCRIPT = `Object.defineProperty(navigator, 'webdriver', {
  get: () => undefined,
});`;

export async function hideAutomationFlags(page: Page): Promise<void> {
  await page.addInitScript(HIDE_AUTOMATION_FLAGS_SCRIPT);
  await page.evaluate(HIDE_AUTOMATION_FLAGS_SCRIPT).catch(() => undefined);
}
