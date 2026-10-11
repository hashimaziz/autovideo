/**
 * Element highlighting — draw attention to a thing without saying anything.
 *
 * A product video's hardest job is telling the viewer where to look. The original workflow solved
 * it with the cursor alone, which means the cursor had to travel to every reading and a five-value
 * panel took fifteen seconds of pointing at numbers.
 *
 * Highlighting is the other half of that: a ring around the element while the cursor, the copy and
 * the viewer all attend to it at once.
 *
 * ### Why it is measured every frame
 *
 * The obvious implementation injects an overlay once, positioned at the element's box at that
 * moment. It drifts the instant the page moves — and pages move in these videos, because scrolling
 * is the main camera operation. A highlight that slides off the thing it is highlighting is worse
 * than none.
 *
 * So the overlay holds no position of its own. Each frame it re-reads the target's
 * `getBoundingClientRect()` inside the page and paints there. Scrolling, reflow, a layout
 * animation and a sticky header are all handled for free, because the measurement happens against
 * live layout rather than a remembered one. The cost is one `getBoundingClientRect()` per frame,
 * which is nothing next to a screenshot.
 *
 * This is the same trick the cursor overlay uses — it is also re-placed every frame — and the same
 * reason: frame N's contents must be a function of frame N alone, not of history.
 */

import type { Page } from 'playwright';

/** Attribute marking our own nodes, so cleanup can find them and apps can exclude them. */
const HIGHLIGHT_ATTRIBUTE = 'data-autovideo';

const HIGHLIGHT_SELECTOR = `[${HIGHLIGHT_ATTRIBUTE}="highlight"]`;

const HIGHLIGHT_STYLE_ID = 'autovideo-highlight-style';

/**
 * Defaults chosen to read as "annotation" rather than "error".
 *
 * Amber is what a presenter reaches for when circling something on a screen share; red would claim
 * something is wrong, and blue would claim something is merely selected.
 */
export const DEFAULT_HIGHLIGHT = {
  color: '#ffb020',
  fill: 'rgba(255, 176, 32, 0.10)',
  borderWidth: 3,
  radius: 10,
  padding: 6,
  fadeMs: 180,
} as const;

/** How a highlight should look and how long it should last. */
export interface HighlightOptions {
  /** Ring colour. Defaults to amber. */
  color?: string;
  /** Translucent fill inside the ring. Pass `'transparent'` for an outline only. */
  fill?: string;
  /** Ring thickness in CSS pixels. */
  borderWidth?: number;
  /** Corner radius in CSS pixels. */
  radius?: number;
  /** Space between the element's border and the ring, in CSS pixels. */
  padding?: number;
  /**
   * How long the highlight stays up.
   *
   * Omit to leave it up until the next `highlight()` or an explicit `clearHighlight()`. Give it a
   * duration and it fades out on its own, which is what a self-contained call site wants.
   */
  durationMs?: number;
  /** Fade duration in and out, in logical milliseconds. Defaults to 180. */
  fadeMs?: number;
}

/** A highlight as it stands at one moment. */
export interface HighlightVisual {
  /** The element to ring, or null when nothing is highlighted. */
  selector: string | null;
  /** 0 → 1 while fading in, 1 while held, 1 → 0 while fading out. */
  opacity: number;
  options: Required<Omit<HighlightOptions, 'durationMs'>>;
}

/**
 * Deliberately contains no `transition`, no `animation` and no keyframes.
 *
 * Opacity is written every frame by {@link HighlightOverlay.render} from a value sampled in Node,
 * so any page-side animation would fight it: a CSS transition runs on wall-clock time inside the
 * browser, so the same frames would fade differently from run to run — exactly the non-determinism
 * the logical clock exists to remove. A scale animation would also perturb the ring's own
 * geometry, making the box measured back out of the page disagree with the element it rings.
 */
const CSS = `
[${HIGHLIGHT_ATTRIBUTE}="highlight"] {
  position: fixed;
  pointer-events: none;
  /* Above the page, below nothing: the ring must never be occluded by the thing it rings. */
  z-index: 2147483646;
  box-sizing: border-box;
  will-change: opacity;
  mix-blend-mode: normal;
}
[${HIGHLIGHT_ATTRIBUTE}="highlight-label"] {
  position: absolute;
  top: -1.35em;
  left: 0;
  font: 600 13px/1.2 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  letter-spacing: 0.01em;
  padding: 3px 8px;
  border-radius: 6px;
  white-space: nowrap;
  background: currentColor;
}
[${HIGHLIGHT_ATTRIBUTE}="highlight-label"] > span {
  /* The label inherits the ring's colour as its background, so the text needs its own colour. */
  color: #0b1020;
}
`;

/**
 * Owns the highlight overlay in the page.
 *
 * One instance per run, like the cursor overlay. Position is recomputed every frame, so this holds
 * no geometry between calls.
 */
export class HighlightOverlay {
  readonly #page: Page;

  /** Reset on navigation, so the overlay is re-created in the new document. */
  #bound = false;

  constructor(page: Page) {
    this.#page = page;

    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.#bound = false;
    });
  }

  /** Inject the stylesheet if absent. Safe to call repeatedly and after navigation. */
  async ensureStyles(): Promise<void> {
    const present = await this.#page
      .evaluate(`document.getElementById(${JSON.stringify(HIGHLIGHT_STYLE_ID)}) !== null`)
      .catch(() => false);

    if (present) {
      this.#bound = true;
      return;
    }

    await this.#page
      .addStyleTag({ content: CSS })
      .then(() => {
        // addStyleTag cannot set an id, so tag it afterwards for the check above.
        void this.#page.evaluate(`(() => {
          const styles = document.querySelectorAll('style');
          const last = styles[styles.length - 1];
          if (last) last.id = ${JSON.stringify(HIGHLIGHT_STYLE_ID)};
        })()`);
      })
      .catch(() => undefined);

    this.#bound = true;
  }

  /**
   * Paint the highlight for one frame.
   *
   * Returns false when the target is gone, so the caller can drop the highlight rather than leave
   * a ring frozen over whatever has since occupied that space — the single most alarming way for
   * a highlighting bug to present.
   */
  async render(visual: HighlightVisual): Promise<boolean> {
    if (!this.#bound) await this.ensureStyles();
    if (!this.#bound) return false;

    if (visual.selector === null) {
      await this.#remove();
      return false;
    }

    const { selector, opacity, options } = visual;
    const { color, fill, borderWidth, radius, padding } = options;

    return this.#page
      .evaluate(
        `(() => {
          const target = document.querySelector(${JSON.stringify(selector)});
          if (!target) return false;

          let ring = document.querySelector(${JSON.stringify(HIGHLIGHT_SELECTOR)});
          if (!ring) {
            ring = document.createElement('div');
            ring.setAttribute(${JSON.stringify(HIGHLIGHT_ATTRIBUTE)}, 'highlight');
            // On documentElement, for the same reason as the cursor: body may not exist yet and
            // an ancestor's overflow must not clip the ring.
            document.documentElement.appendChild(ring);
          }

          const rect = target.getBoundingClientRect();

          // A display:none element reports a zero box. Ring it at nothing rather than drawing a
          // degenerate rectangle in the corner.
          if (rect.width === 0 && rect.height === 0) return false;

          ring.style.left = (rect.left - ${padding}) + 'px';
          ring.style.top = (rect.top - ${padding}) + 'px';
          ring.style.width = (rect.width + ${padding * 2}) + 'px';
          ring.style.height = (rect.height + ${padding * 2}) + 'px';
          // The whole declaration has to be one JS string literal. Interpolating a bare hex
          // colour produces 3px solid "#ffb020" unquoted, which is a syntax error rather than a
          // wrong colour — and the catch below would swallow that, so the ring would silently
          // never appear at all.
          ring.style.border = ${JSON.stringify(`${borderWidth}px solid ${color}`)};
          ring.style.background = ${JSON.stringify(fill)};
          ring.style.borderRadius = ${JSON.stringify(`${radius}px`)};
          ring.style.opacity = ${opacity.toFixed(3)};


          return true;
        })()`,
      )
      .then((visible) => visible === true)
      .catch(() => false);
  }

  /** Remove the overlay. */
  async #remove(): Promise<void> {
    await this.#page
      .evaluate(
        `(() => {
        const ring = document.querySelector(${JSON.stringify(HIGHLIGHT_SELECTOR)});
        if (ring) ring.remove();
      })()`,
      )
      .catch(() => undefined);
  }

  /** Remove the ring if present. Called every frame when nothing is highlighted. */
  async clear(): Promise<void> {
    if (!this.#bound) return;
    await this.#remove();
  }

  /** Remove the overlay entirely, for teardown. */
  async destroy(): Promise<void> {
    await this.#page
      .evaluate(
        `(() => {
        for (const node of document.querySelectorAll('[${HIGHLIGHT_ATTRIBUTE}="highlight"]')) {
          node.remove();
        }
      })()`,
      )
      .catch(() => undefined);
  }
}

/** Fill in the defaults for a call that supplied none. */
export function resolveHighlightOptions(
  options: HighlightOptions = {},
): Required<Omit<HighlightOptions, 'durationMs'>> {
  return {
    color: options.color ?? DEFAULT_HIGHLIGHT.color,
    fill: options.fill ?? DEFAULT_HIGHLIGHT.fill,
    borderWidth: options.borderWidth ?? DEFAULT_HIGHLIGHT.borderWidth,
    radius: options.radius ?? DEFAULT_HIGHLIGHT.radius,
    padding: options.padding ?? DEFAULT_HIGHLIGHT.padding,
    fadeMs: options.fadeMs ?? DEFAULT_HIGHLIGHT.fadeMs,
  };
}
