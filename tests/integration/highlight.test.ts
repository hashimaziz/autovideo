import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveConfig } from '../../src/config/config.js';
import { launchBrowser, type BrowserSession } from '../../src/browser/session.js';
import {
  DEFAULT_HIGHLIGHT,
  HighlightOverlay,
  resolveHighlightOptions,
} from '../../src/motion/highlight.js';
import { createFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

/**
 * Element highlighting, against a real page.
 *
 * The behaviour worth guarding is not "draws a rectangle" — it is that the rectangle *tracks the
 * element*. A highlight is positioned from live layout on every frame, and these tests exist to
 * stop that from being quietly optimised back into a one-time measurement.
 */
describe('highlight overlay', () => {
  let server: FixtureServer;
  let session: BrowserSession;
  let overlay: HighlightOverlay;
  let workDir: string;

  const config = resolveConfig({ viewport: { width: 1080, height: 1920 }, layoutScale: 1 });

  const RING = '[data-autovideo="highlight"]';

  const box = () =>
    session.page.evaluate((selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }, RING);

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'autovideo-highlight-'));
    server = await createFixtureServer();
    session = await launchBrowser(config);
    await session.page.goto(server.url('/highlight.html'));
    overlay = new HighlightOverlay(session.page);
  });

  afterEach(async () => {
    await overlay?.destroy();
    await session?.close();
    await server?.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it('injects a stylesheet, idempotently', async () => {
    for (let index = 0; index < 5; index++) await overlay.ensureStyles();

    const styles = await session.page.evaluate(
      () => document.querySelectorAll('#autovideo-highlight-style').length,
    );

    expect(styles).toBe(1);
  });

  it('reports false and draws nothing when no target is set', async () => {
    await overlay.render({ selector: null, opacity: 1, options: resolveHighlightOptions() });

    expect(await session.page.locator(RING).count()).toBe(0);
  });

  it('rings the target element', async () => {
    const painted = await overlay.render({
      selector: '#target',
      opacity: 1,
      options: resolveHighlightOptions(),
    });
    const target = await session.page.evaluate(() => {
      const rect = document.querySelector('#target')!.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    const ring = await box();

    expect(painted).toBe(true);
    expect(ring).not.toBeNull();
    // Inset by the default padding, and outset by the same amount in size.
    expect(ring!.x).toBeCloseTo(target.x - DEFAULT_HIGHLIGHT.padding, 0);
    expect(ring!.y).toBeCloseTo(target.y - DEFAULT_HIGHLIGHT.padding, 0);
    expect(ring!.width).toBeCloseTo(target.width + DEFAULT_HIGHLIGHT.padding * 2, 0);
    expect(ring!.height).toBeCloseTo(target.height + DEFAULT_HIGHLIGHT.padding * 2, 0);
  });

  it('reuses one ring element across frames', async () => {
    // The pump renders every frame. A ring recreated per frame would churn the DOM 900 times a
    // minute and restart its CSS animation every time, so it would sit permanently part-faded.
    for (let index = 0; index < 4; index++) {
      await overlay.render({ selector: '#target', opacity: 1, options: resolveHighlightOptions() });
    }

    expect(await session.page.locator(RING).count()).toBe(1);
  });

  it('moves with the element when the page scrolls', async () => {
    // The reason the overlay measures every frame. A one-time measurement would leave the ring
    // behind at the pre-scroll position, ring-ing empty space.
    await overlay.render({ selector: '#target', opacity: 1, options: resolveHighlightOptions() });
    const before = await box();

    await session.page.evaluate(() => window.scrollBy(0, 300));
    await session.page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );

    await overlay.render({ selector: '#target', opacity: 1, options: resolveHighlightOptions() });
    const after = await box();

    expect(after!.y).toBeCloseTo(before!.y - 300, 0);
  });

  it('follows an element that moves for a reason other than scrolling', async () => {
    // Reflow, a disclosure opening, an animation. All are the same problem as scrolling.
    await overlay.render({ selector: '#target', opacity: 1, options: resolveHighlightOptions() });
    const before = await box();

    await session.page.evaluate(() => {
      (document.querySelector('#target') as HTMLElement).style.marginTop = '120px';
    });
    await overlay.render({ selector: '#target', opacity: 1, options: resolveHighlightOptions() });
    const after = await box();

    expect(after!.y).toBeCloseTo(before!.y + 120, 0);
  });

  it('reports false when the target does not exist', async () => {
    // The caller drops the highlight on this, rather than leaving a ring over whatever now
    // occupies that space.
    const painted = await overlay.render({
      selector: '#no-such-element',
      opacity: 1,
      options: resolveHighlightOptions(),
    });

    expect(painted).toBe(false);
    expect(await session.page.locator(RING).count()).toBe(0);
  });

  it('reports false for a hidden target rather than drawing a degenerate box', async () => {
    // display:none reports a zero rect. Ringing that produces a dot in the corner of the frame.
    const painted = await overlay.render({
      selector: '#target',
      opacity: 1,
      options: resolveHighlightOptions(),
    });
    expect(painted).toBe(true);

    await session.page.evaluate(() => {
      (document.querySelector('#target') as HTMLElement).style.display = 'none';
    });
    const repainted = await overlay.render({
      selector: '#target',
      opacity: 1,
      options: resolveHighlightOptions(),
    });

    expect(repainted).toBe(false);
  });

  it('applies the caller’s colour, padding and radius', async () => {
    const options = resolveHighlightOptions({ color: '#00ff88', padding: 20, radius: 2 });
    await overlay.render({ selector: '#target', opacity: 1, options });

    const style = await session.page.evaluate((selector) => {
      const node = document.querySelector(selector) as HTMLElement;
      const computed = getComputedStyle(node);
      return { border: computed.borderTopColor, radius: node.style.borderRadius };
    }, RING);
    const target = await session.page.evaluate(
      () => document.querySelector('#target')!.getBoundingClientRect().x,
    );

    // rgb(0, 255, 136) — the browser normalises hex to rgb(), which is why this is not '#00ff88'.
    expect(style.border).toBe('rgb(0, 255, 136)');
    expect(style.radius).toBe('2px');
    const ring = await box();
    expect(ring!.x).toBeCloseTo(target - 20, 0);
  });

  it('applies opacity from the sampled fade', async () => {
    await overlay.render({
      selector: '#target',
      opacity: 0.35,
      options: resolveHighlightOptions(),
    });

    const opacity = await session.page.evaluate(
      (selector) => (document.querySelector(selector) as HTMLElement).style.opacity,
      RING,
    );

    expect(Number(opacity)).toBeCloseTo(0.35, 2);
  });

  it('clears the ring on demand', async () => {
    await overlay.render({ selector: '#target', opacity: 1, options: resolveHighlightOptions() });
    await overlay.clear();

    expect(await session.page.locator(RING).count()).toBe(0);
  });

  it('removes everything on destroy', async () => {
    await overlay.render({ selector: '#target', opacity: 1, options: resolveHighlightOptions() });
    await overlay.destroy();

    expect(await session.page.locator(RING).count()).toBe(0);
  });

  it('survives navigation by re-binding', async () => {
    // A navigation destroys the overlay with the rest of the document. Without re-binding, the
    // ring would silently vanish from the rest of the video.
    await overlay.render({ selector: '#target', opacity: 1, options: resolveHighlightOptions() });

    await session.page.goto(server.url('/highlight.html'));
    const painted = await overlay.render({
      selector: '#target',
      opacity: 1,
      options: resolveHighlightOptions(),
    });

    expect(painted).toBe(true);
    expect(await session.page.locator(RING).count()).toBe(1);
  });

  describe('option defaults', () => {
    it('falls back to the documented defaults', () => {
      expect(resolveHighlightOptions()).toEqual({
        color: DEFAULT_HIGHLIGHT.color,
        fill: DEFAULT_HIGHLIGHT.fill,
        borderWidth: DEFAULT_HIGHLIGHT.borderWidth,
        radius: DEFAULT_HIGHLIGHT.radius,
        padding: DEFAULT_HIGHLIGHT.padding,
        fadeMs: DEFAULT_HIGHLIGHT.fadeMs,
      });
    });

    it('keeps a supplied value', () => {
      expect(resolveHighlightOptions({ color: '#123456' }).color).toBe('#123456');
    });
  });
});
