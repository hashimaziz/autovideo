/**
 * Scroll container detection.
 *
 * Ported from the audited reference implementation, which solved a genuinely tricky problem.
 *
 * Many apps set `html, body { height: 100% }` and `overflow-x: hidden` on html. That makes
 * **body** the scrolling element: `document.body.scrollHeight` is the real content height while
 * `documentElement.scrollHeight` and `window.innerHeight` are both just the viewport height. The
 * consequences are nasty and silent:
 *
 * - `window.scrollTo()` and `window.scrollY` become no-ops.
 * - Clamping a target against `documentElement.scrollHeight` yields `viewport - viewport = 0`,
 *   so every scroll does nothing while appearing to succeed.
 *
 * So the scroller is detected at runtime rather than assumed. This keeps working for pages that
 * scroll normally, pages that scroll `body`, and content inside a modal's own scroll area.
 */

/**
 * Resolve the scrolling element.
 *
 * Passed to the page as a **string**, never as a function. The TypeScript runner rewrites named
 * functions with a `__name` helper that does not exist in the browser, so they throw — and when
 * the call is wrapped in a `.catch`, that throw is swallowed and the action silently reports
 * success. This constraint is asserted by a unit test on the exported constant.
 */
export const RESOLVE_SCROLLER_SCRIPT = `(() => {
  const candidates = [
    ['body', document.body],
    ['html', document.scrollingElement || document.documentElement],
  ];
  for (const [name, element] of candidates) {
    if (element && element.scrollHeight > element.clientHeight + 2) return name;
  }
  return 'window';
})()`;

/** Which element actually scrolls on a given page. */
export type ScrollTarget = 'body' | 'html' | 'window';

/** Current scroll offset and how far it can go. */
export interface ScrollMetrics {
  target: ScrollTarget;
  offset: number;
  /** Furthest reachable offset. */
  limit: number;
}

/** Build a page-side expression that applies a scroll offset to the given target. */
function scrollSetterScript(target: ScrollTarget, offsetY: number): string {
  const wanted = Math.round(offsetY);
  return `(() => {
    const target = ${JSON.stringify(target)};
    const element = target === 'body' ? document.body
      : target === 'html' ? (document.scrollingElement || document.documentElement)
      : null;
    const y = ${wanted};
    if (element) { element.scrollTop = y; } else { window.scrollTo(0, y); }
  })()`;
}

/**
 * Which element scrolls on this page.
 *
 * Falls back to `window` if detection fails, which is the safe default: it is what a
 * conventionally-scrolling page uses.
 */
export async function resolveScrollTarget(
  evaluate: (script: string) => Promise<unknown>,
): Promise<ScrollTarget> {
  const target = await evaluate(RESOLVE_SCROLLER_SCRIPT).catch(() => 'window');
  return target === 'body' || target === 'html' ? target : 'window';
}

/** Read the current scroll offset and limit. */
export async function readScrollMetrics(
  evaluate: (script: string) => Promise<unknown>,
  target: ScrollTarget,
): Promise<ScrollMetrics> {
  const raw = await evaluate(`(() => {
    const target = ${JSON.stringify(target)};
    const element = target === 'body' ? document.body
      : target === 'html' ? (document.scrollingElement || document.documentElement)
      : null;
    const offset = element ? element.scrollTop : window.scrollY;
    const height = element ? element.scrollHeight : document.documentElement.scrollHeight;
    const client = element ? element.clientHeight : window.innerHeight;
    return { offset, limit: Math.max(0, height - client) };
  })()`);

  const { offset, limit } = (raw ?? { offset: 0, limit: 0 }) as {
    offset?: number;
    limit?: number;
  };

  return {
    target,
    offset: offset ?? 0,
    limit: limit ?? 0,
  };
}

/**
 * Apply a scroll offset immediately, clamping to what the page can actually reach.
 *
 * This is the *instant* setter. Animated scrolling goes through the motion track, which owns
 * the easing; this exists for frames where the position must be exact and immediate.
 */
export async function applyScrollOffset(
  evaluate: (script: string) => Promise<unknown>,
  target: ScrollTarget,
  offsetY: number,
): Promise<void> {
  await evaluate(scrollSetterScript(target, offsetY));
}

/**
 * Compute the offset that centres an element vertically in the viewport.
 *
 * `getBoundingClientRect().top` is **viewport**-relative — the current scroll offset has
 * already been subtracted. Adding an `offsetTop` chain on top of it double-counts, which sends
 * the target past the end of the document and clamps it to the scroll limit. The audited
 * implementation had exactly this bug and it presented as a scroll that went nowhere while
 * reporting success.
 *
 * @returns The absolute offset to scroll to, or null if the element could not be measured.
 */
export function centringOffsetFromMeasurement(measurement: RawMeasurement): number {
  const { rect, offset, limit, viewportHeight } = measurement;

  // An element taller than the viewport cannot be centred without scrolling past its own top,
  // so align it just under the header instead.
  const tooTall = rect.height >= viewportHeight - 96;
  const desired = tooTall
    ? rect.top + offset - 72
    : rect.top + offset - (viewportHeight - rect.height) / 2;

  return Math.max(0, Math.min(Math.round(desired), limit));
}

/** What the page reports about an element and the current scroll position. */
export interface RawMeasurement {
  rect: { top: number; bottom: number; height: number };
  /** Current scroll offset of whichever element scrolls. */
  offset: number;
  limit: number;
  viewportHeight: number;
}

/**
 * Page-side script that measures an element and the current scroll position.
 *
 * A string, like every other script in this module: named functions passed to `page.evaluate`
 * get rewritten by the TypeScript runner with a `__name` helper that does not exist in the
 * browser, and inside a `.catch` that throw reads as success.
 */
export function measureElementScript(selector: string): string {
  return `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const container = document.scrollingElement && document.scrollingElement.tagName === 'BODY'
      ? document.body
      : document.scrollingElement || document.documentElement;
    const offset = container ? container.scrollTop : window.scrollY;
    const height = container ? container.scrollHeight : document.documentElement.scrollHeight;
    const client = container ? container.clientHeight : window.innerHeight;
    return {
      rect: { top: rect.top, bottom: rect.bottom, height: rect.height },
      offset,
      limit: Math.max(0, height - client),
      viewportHeight: window.innerHeight,
    };
  })()`;
}

/**
 * Whether an element is comfortably in view.
 *
 * Used to decide whether the cursor needs to scroll before moving. Skipping an unnecessary
 * scroll matters: the audited implementation double-scrolled on every pointer move because it
 * re-centred unconditionally, and the page visibly drifted.
 */
export const IS_IN_VIEW_SCRIPT = `(node) => {
  const rect = node.getBoundingClientRect();
  // Clear of the sticky header and the bottom edge.
  return rect.top >= 64 && rect.bottom <= window.innerHeight - 16;
}`;
