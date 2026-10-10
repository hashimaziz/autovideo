/**
 * The video cursor.
 *
 * ### Why this exists at all
 *
 * The audit established empirically that Playwright's screencast never draws a mouse cursor
 * (ARCHITECTURE_AUDIT.md §5.1). A framework whose stated goal is "cursor movement and visibility
 * as a first-class video concept" cannot ship on that backend, so the cursor has to be drawn by
 * the framework instead of captured from the browser.
 *
 * ### Why it is drawn into the page
 *
 * The overlay is a DOM element in the page under `position: fixed`, repositioned imperatively on
 * every frame — *not* animated with CSS transitions. Three consequences, all deliberate:
 *
 * - No image-compositing dependency. Compositing a PNG onto every captured frame in Node would
 *   pull in an image library for one sprite.
 * - It scales correctly with the layout viewport, so a 1080x1920 video gets a proportionate
 *   cursor without any per-preset tuning.
 * - It stays deterministic because *we* set the transform each frame. A CSS animation would run
 *   off the compositor clock and could differ between frames that should be identical.
 *
 * `position: fixed` at `documentElement` level also escapes ancestor `overflow: hidden`, which
 * would otherwise clip the cursor on any page with a scrolling container.
 *
 * ### Cursor and mouse are separate things
 *
 * The plan requires this explicitly. The real Playwright mouse still moves underneath, so hover
 * states and click hit-testing are genuine browser behaviour. The overlay is only what a *viewer*
 * sees. In `native` mode the two are tied together more tightly, which is what a developer wants
 * when debugging a script live — but overlay mode remains the default because it is the one that
 * looks the same on every machine.
 */

import type { Page } from 'playwright';

import type { CursorConfig } from '../config/config.js';
import type { Easing } from '../motion/easing.js';
import { easeInOutCubic } from '../motion/easing.js';
import { animatePoint } from '../motion/track.js';
import { travelDuration, type Point } from '../motion/interpolation.js';

/** Attribute marking the overlay, so the determinism stylesheet can exempt it. */
export const CURSOR_ATTRIBUTE = 'data-autovideo';
export const CURSOR_SELECTOR = `[${CURSOR_ATTRIBUTE}="cursor"]`;

const CURSOR_STYLE_ID = 'autovideo-cursor-style';

/**
 * Stylesheet for the overlay.
 *
 * Inline styles and `!important` everywhere, because the host page may define aggressive global
 * rules (`* { transition: ... }` is common) and the cursor must win regardless. Injected once per
 * document; the element itself is re-created on navigation.
 */
const CURSOR_CSS = `
  [${CURSOR_ATTRIBUTE}="cursor"] {
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    width: 22px !important;
    height: 26px !important;
    /* No transition: the framework sets the transform on every frame. A transition would fight
       it and reintroduce wall-clock dependence. */
    transition: none !important;
    animation: none !important;
    pointer-events: none !important;
    z-index: 2147483647 !important;
    will-change: transform !important;
    transform-origin: 2px 2px !important;
  }
  [${CURSOR_ATTRIBUTE}="cursor"] > svg {
    display: block !important;
    width: 100% !important;
    height: 100% !important;
    filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.55)) !important;
  }
  [${CURSOR_ATTRIBUTE}="ripple"] {
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    width: 44px !important;
    height: 44px !important;
    margin: -22px 0 0 -22px !important;
    border-radius: 50% !important;
    border: 3px solid rgba(120, 170, 255, 0.95) !important;
    pointer-events: none !important;
    z-index: 2147483646 !important;
    /* Opacity and scale are set inline every frame by the framework. */
    animation: none !important;
    transition: none !important;
  }
`;

/**
 * Build the arrow glyph.
 *
 * Inline SVG rather than a font or an image file: it scales with the layout viewport for free,
 * needs no bundler asset pipeline, and is byte-identical on every machine.
 */
function arrowMarkup(): string {
  return `<svg viewBox="0 0 22 26" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M1 1 L1 21.5 L6.2 16.6 L9.4 24.4 L12.6 23.1 L9.5 15.6 L16.6 15.4 Z"
          fill="#ffffff" stroke="#0b1020" stroke-width="1.4" stroke-linejoin="round"/>
  </svg>`;
}

/** What the overlay currently looks like. */
export interface CursorVisual {
  position: Point;
  visible: boolean;
  /** 0 when there is no ripple, otherwise 1 → 0 over its lifetime. */
  clickEmphasis: number;
}

/**
 * Owns the overlay in the page.
 *
 * One instance per run. Position updates are idempotent and cheap, because they happen on every
 * frame.
 */
export class CursorOverlay {
  readonly #page: Page;

  readonly #config: CursorConfig;

  /** Injected on navigation, so the overlay survives a page load mid-video. */
  #bound = false;

  constructor(page: Page, config: CursorConfig) {
    this.#page = page;
    this.#config = config;

    // A navigation destroys the overlay along with the rest of the document. Without this the
    // flag stays true, render() skips re-creation, and the cursor silently disappears from the
    // frame for the rest of the video — which is precisely the bug this listener prevents.
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.#bound = false;
    });
  }

  /** Inject the stylesheet if absent. Safe to call repeatedly and after navigation. */
  async ensureStyles(): Promise<void> {
    const present = await this.#page
      .evaluate(`document.getElementById(${JSON.stringify(CURSOR_STYLE_ID)}) !== null`)
      .catch(() => false);

    if (present) {
      this.#bound = true;
      return;
    }

    await this.#page
      .addStyleTag({ content: CURSOR_CSS })
      .then(() => {
        // `addStyleTag` cannot set an id, so tag it afterwards for the idempotency check above.
        void this.#page.evaluate(`(() => {
          const styles = document.querySelectorAll('style');
          const last = styles[styles.length - 1];
          if (last) last.id = ${JSON.stringify(CURSOR_STYLE_ID)};
        })()`);
      })
      .catch(() => undefined);

    this.#bound = true;
  }

  /** Create the overlay element if it is not already present. */
  async ensureElement(): Promise<void> {
    await this.ensureStyles();

    await this.#page
      .evaluate(
        `(() => {
          if (document.querySelector(${JSON.stringify(CURSOR_SELECTOR)})) return;
          const cursor = document.createElement('div');
          cursor.setAttribute(${JSON.stringify(CURSOR_ATTRIBUTE)}, 'cursor');
          cursor.innerHTML = ${JSON.stringify(arrowMarkup())};
          cursor.style.transform = 'translate(-100px, -100px)';
          cursor.style.opacity = '0';
          // Appended to documentElement rather than body: position:fixed at this level is not
          // clipped by any ancestor's overflow, and body may not exist during navigation.
          document.documentElement.appendChild(cursor);
        })()`,
      )
      .catch(() => undefined);
  }

  /**
   * Place the cursor for a given frame.
   *
   * @param emphasis `0` for no click ripple, or `1 → 0` to fade one out.
   */
  async render(visual: CursorVisual): Promise<void> {
    if (!this.#bound) await this.ensureElement();
    if (!this.#bound) return;

    const { position, visible, clickEmphasis } = visual;
    const { x, y } = position;

    await this.#page
      .evaluate(
        `(() => {
          const cursor = document.querySelector(${JSON.stringify(CURSOR_SELECTOR)});
          if (!cursor) return;
          cursor.style.transform = 'translate3d(${x}px, ${y}px, 0)';
          cursor.style.opacity = ${visible ? 1 : 0};
          ${this.#rippleScript(x, y, clickEmphasis)}
        })()`,
      )
      .catch(() => undefined);
  }

  /**
   * Page-side snippet that creates, positions and fades the click ripple.
   *
   * `emphasis` runs 1 → 0. At 0 the ripple is removed outright rather than left at opacity 0,
   * so it cannot be caught by an accessibility sweep or a `querySelectorAll('[data-autovideo]')`.
   */
  #rippleScript(x: number, y: number, emphasis: number): string {
    if (!this.#config.clickEmphasis || emphasis <= 0) {
      return `(() => {
        const stale = document.querySelector('[${CURSOR_ATTRIBUTE}="ripple"]');
        if (stale) stale.remove();
      })()`;
    }

    // Scale grows as the ripple fades: it reads as the click's energy dissipating.
    const scale = (0.35 + (1 - emphasis) * 0.9).toFixed(3);

    return `(() => {
      let ripple = document.querySelector('[${CURSOR_ATTRIBUTE}="ripple"]');
      if (!ripple) {
        ripple = document.createElement('div');
        ripple.setAttribute(${JSON.stringify(CURSOR_ATTRIBUTE)}, 'ripple');
        document.documentElement.appendChild(ripple);
      }
      ripple.style.transform = 'translate3d(${x}px, ${y}px, 0) scale(${scale})';
      ripple.style.opacity = ${emphasis.toFixed(3)};
    })()`;
  }

  /** Remove the overlay entirely. Used on teardown. */
  async destroy(): Promise<void> {
    await this.#page
      .evaluate(
        `(() => {
          for (const node of document.querySelectorAll('[${CURSOR_ATTRIBUTE}="cursor"],[${CURSOR_ATTRIBUTE}="ripple"]')) {
            node.remove();
          }
        })()`,
      )
      .catch(() => undefined);
  }
}

/** Options for building a cursor path. */
export interface CursorMoveOptions {
  durationMs?: number;
  easing?: Easing;
  /** Perpendicular bulge as a fraction of travel distance. 0 is a straight line. */
  bow?: number;
  /**
   * Multiplier on the distance-derived duration, when no explicit duration is given.
   *
   * The caller draws this from a seeded stream, so the same script always produces the same
   * variation — which is the point. A fixed duration makes two cursors covering the same
   * distance look mechanically identical.
   */
  travelFactor?: number;
}

/**
 * Plan a cursor move.
 *
 * Returns the animation plus its duration, so the caller can await it on the logical clock.
 *
 * The default duration scales with distance. A short hop across a button should not take as long
 * as a sweep down the frame, and using one fixed duration for both is the tell of a fake cursor.
 * The 120ms floor stops a 4px correction from being a single-frame jump, which reads as a
 * glitch; the 900ms ceiling stops a very long sweep from looking like a slow drift. An explicit
 * `durationMs` overrides both, and `travelFactor` scales the derived one.
 */
export function planMove(
  from: Point,
  to: Point,
  startMs: number,
  options: CursorMoveOptions = {},
): { animation: (atMs: number) => Point; durationMs: number } {
  const travel = travelDuration(from, to) * (options.travelFactor ?? 1);
  const durationMs = options.durationMs ?? Math.min(900, Math.max(120, travel));

  const animation = animatePoint(startMs, startMs + durationMs, from, to, {
    easing: options.easing ?? easeInOutCubic,
    bow: options.bow ?? 0,
  });

  return { animation, durationMs };
}

/**
 * A small seeded multiplier around 1.
 *
 * Used so repeated motions of the same distance do not read as a loop. The draw comes from a
 * named seeded stream, so the variation is identical on every re-run of the same script.
 */
export function naturalVariation(rng: { between(min: number, max: number): number }): number {
  return 1 + rng.between(-0.06, 0.06);
}
