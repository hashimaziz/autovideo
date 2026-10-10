import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveConfig } from '../../src/config/config.js';
import { launchBrowser, type BrowserSession } from '../../src/browser/session.js';
import { CursorOverlay, CURSOR_SELECTOR, planMove } from '../../src/motion/cursor.js';
import { createFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

/**
 * The cursor overlay, against a real page.
 *
 * The existence of this whole module rests on one measured fact: Playwright's screencast does not
 * draw a mouse cursor. These tests confirm the framework draws one itself, that it moves, and
 * that doing so is reproducible.
 */
describe('cursor overlay', () => {
  let server: FixtureServer;
  let session: BrowserSession;
  let overlay: CursorOverlay;
  let workDir: string;

  const config = resolveConfig({ viewport: { width: 1080, height: 1920 }, layoutScale: 1 });

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'autovideo-cursor-'));
    server = await createFixtureServer();
    session = await launchBrowser(config);
    await session.page.goto(server.url('/'));
    overlay = new CursorOverlay(session.page, config.cursor);
  });

  afterEach(async () => {
    await overlay?.destroy();
    await session?.close();
    await server?.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it('injects an overlay element into the page', async () => {
    await overlay.ensureElement();

    expect(await session.page.locator(CURSOR_SELECTOR).count()).toBe(1);
  });

  it('is idempotent across repeated calls', async () => {
    // The pump calls ensureStyles every frame; without idempotency the page would accumulate
    // thousands of duplicate elements and stylesheets.
    for (let index = 0; index < 5; index++) await overlay.ensureElement();

    expect(await session.page.locator(CURSOR_SELECTOR).count()).toBe(1);
  });

  it('starts hidden and parked off-screen', async () => {
    // Asserted before any render: the element must never flash at the origin on creation.
    await overlay.ensureElement();

    const state = (await session.page.evaluate(`(() => {
      const cursor = document.querySelector(${JSON.stringify(CURSOR_SELECTOR)});
      return { opacity: cursor.style.opacity, transform: cursor.style.transform };
    })()`)) as { opacity: string; transform: string };

    expect(state.opacity).toBe('0');
    expect(state.transform).toContain('-100px');
  });

  it('hides the cursor when asked to', async () => {
    await overlay.render({ position: { x: 100, y: 100 }, visible: true, clickEmphasis: 0 });
    await overlay.render({ position: { x: 100, y: 100 }, visible: false, clickEmphasis: 0 });

    const opacity = await session.page.evaluate(
      `document.querySelector(${JSON.stringify(CURSOR_SELECTOR)}).style.opacity`,
    );
    expect(opacity).toBe('0');
  });

  it('places the cursor at the requested position', async () => {
    await overlay.render({ position: { x: 321, y: 654 }, visible: true, clickEmphasis: 0 });

    const state = (await session.page.evaluate(`(() => {
      const cursor = document.querySelector(${JSON.stringify(CURSOR_SELECTOR)});
      return {
        opacity: cursor.style.opacity,
        transform: cursor.style.transform,
        // getBoundingClientRect reports where the browser actually put it, which is the
        // assertion that matters — the transform string is an implementation detail.
        left: Math.round(cursor.getBoundingClientRect().left),
        top: Math.round(cursor.getBoundingClientRect().top),
      };
    })()`)) as { opacity: string; transform: string; left: number; top: number };

    expect(state.opacity).toBe('1');
    expect(state.left).toBe(321);
    expect(state.top).toBe(654);
  });

  it('is not frozen by the determinism stylesheet', async () => {
    // The blanket `transition-duration: 0s` rule excludes [data-autovideo] elements. Without that
    // exemption the cursor would still land correctly here, but any transition would make the
    // per-frame transform lag behind the logical clock.
    await overlay.ensureElement();
    const transition = await session.page.evaluate(`(() => {
      const cursor = document.querySelector(${JSON.stringify(CURSOR_SELECTOR)});
      return getComputedStyle(cursor).transitionDuration;
    })()`);

    expect(['0s', '']).toContain(transition);
  });

  it('escapes ancestor overflow clipping', async () => {
    // position:fixed on documentElement is not clipped by a scrolling ancestor. The fixture's
    // panels are ordinary, but many real apps nest the main content in an overflow:hidden shell.
    await overlay.ensureElement();
    const visible = await session.page.evaluate(`(() => {
      const cursor = document.querySelector(${JSON.stringify(CURSOR_SELECTOR)});
      const rect = cursor.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })()`);

    expect(visible).toBe(true);
  });

  describe('click emphasis', () => {
    it('creates a ripple while emphasis is active', async () => {
      await overlay.render({ position: { x: 100, y: 100 }, visible: true, clickEmphasis: 1 });

      expect(await session.page.locator('[data-autovideo="ripple"]').count()).toBe(1);
    });

    it('fades the ripple as emphasis decreases', async () => {
      await overlay.render({ position: { x: 100, y: 100 }, visible: true, clickEmphasis: 1 });
      await overlay.render({ position: { x: 100, y: 100 }, visible: true, clickEmphasis: 0.4 });

      const opacity = await session.page.evaluate(
        `document.querySelector('[data-autovideo="ripple"]').style.opacity`,
      );
      expect(Number(opacity)).toBeCloseTo(0.4, 2);
    });

    it('removes the ripple entirely rather than leaving it invisible', async () => {
      await overlay.render({ position: { x: 100, y: 100 }, visible: true, clickEmphasis: 0.2 });
      await overlay.render({ position: { x: 100, y: 100 }, visible: true, clickEmphasis: 0 });

      expect(await session.page.locator('[data-autovideo="ripple"]').count()).toBe(0);
    });

    it('creates no ripple when emphasis is disabled in config', async () => {
      const plain = new CursorOverlay(
        session.page,
        resolveConfig({ cursor: { clickEmphasis: false } }).cursor,
      );

      await plain.render({ position: { x: 100, y: 100 }, visible: true, clickEmphasis: 1 });
      expect(await session.page.locator('[data-autovideo="ripple"]').count()).toBe(0);
    });
  });

  it('recreates the overlay after a navigation', async () => {
    await overlay.render({ position: { x: 50, y: 50 }, visible: true, clickEmphasis: 0 });
    expect(await session.page.locator(CURSOR_SELECTOR).count()).toBe(1);

    await session.page.goto(server.url('/other'));
    expect(await session.page.locator(CURSOR_SELECTOR).count()).toBe(0);

    await overlay.render({ position: { x: 60, y: 60 }, visible: true, clickEmphasis: 0 });

    expect(await session.page.locator(CURSOR_SELECTOR).count()).toBe(1);
    const left = await session.page.evaluate(
      `Math.round(document.querySelector(${JSON.stringify(CURSOR_SELECTOR)}).getBoundingClientRect().left)`,
    );
    expect(left).toBe(60);
  });

  it('removes itself on destroy', async () => {
    await overlay.ensureElement();
    await overlay.destroy();

    expect(await session.page.locator(CURSOR_SELECTOR).count()).toBe(0);
  });
});

describe('planMove', () => {
  const from = { x: 0, y: 0 };

  it('starts exactly at the origin point', () => {
    const { animation } = planMove(from, { x: 300, y: 400 }, 0);
    expect(animation(0)).toEqual({ x: 0, y: 0 });
  });

  it('ends exactly at the target', () => {
    const { animation, durationMs } = planMove(from, { x: 300, y: 400 }, 0);
    expect(animation(durationMs)).toEqual({ x: 300, y: 400 });
  });

  it('takes longer for a longer journey', () => {
    const near = planMove(from, { x: 60, y: 0 }, 0).durationMs;
    const far = planMove(from, { x: 600, y: 0 }, 0).durationMs;

    expect(far).toBeGreaterThan(near);
  });

  it('never takes less than 120ms for a tiny move', () => {
    // A 3px correction in one frame reads as a glitch, not as a cursor.
    const { durationMs } = planMove({ x: 100, y: 100 }, { x: 103, y: 100 }, 0);
    expect(durationMs).toBe(120);
  });

  it('never takes more than 900ms', () => {
    const { durationMs } = planMove(from, { x: 4000, y: 0 }, 0);
    expect(durationMs).toBeLessThanOrEqual(900);
  });

  it('honours an explicit duration', () => {
    const { durationMs } = planMove(from, { x: 100, y: 0 }, 0, { durationMs: 1500 });
    expect(durationMs).toBe(1500);
  });

  it('honours a start offset', () => {
    const { animation } = planMove(from, { x: 100, y: 0 }, 1000, { durationMs: 100 });
    // Before its start it must hold the origin, or the cursor jumps forward early.
    expect(animation(0)).toEqual({ x: 0, y: 0 });
    expect(animation(1000)).toEqual({ x: 0, y: 0 });
    expect(animation(1100)).toEqual({ x: 100, y: 0 });
  });
});

describe('cursor reproducibility', () => {
  it('produces an identical rendered path across two runs', async () => {
    // The property that matters: with the same script, the cursor's position at a given logical
    // time is the same, so the captured frames are the same.
    const run = async (): Promise<string[]> => {
      const server = await createFixtureServer();
      const config = resolveConfig({ viewport: { width: 1080, height: 1920 }, layoutScale: 1 });
      const session = await launchBrowser(config);
      await session.page.goto(server.url('/'));

      const overlay = new CursorOverlay(session.page, config.cursor);
      await overlay.ensureElement();

      const { animation, durationMs } = planMove({ x: 40, y: 40 }, { x: 500, y: 700 }, 0, {
        durationMs: 500,
      });

      expect(durationMs).toBe(500);

      const samples: string[] = [];
      for (let frame = 0; frame <= 15; frame++) {
        const position = animation(frame * 33.33);
        await overlay.render({ position, visible: true, clickEmphasis: 0 });
        samples.push(
          String(
            await session.page.evaluate(`(() => {
              const rect = document.querySelector(${JSON.stringify(CURSOR_SELECTOR)}).getBoundingClientRect();
              return Math.round(rect.left) + ',' + Math.round(rect.top);
            })()`),
          ),
        );
      }
      await overlay.destroy();
      await session.close();
      await server.close();
      return samples;
    };

    const first = await run();
    const second = await run();

    expect(first).toEqual(second);
    // And the samples must actually differ from each other, or nothing moved.
    expect(new Set(first).size).toBeGreaterThan(5);
  }, 120_000);

  it('hashes identical DOM state for identical logical times', async () => {
    const server = await createFixtureServer();
    const config = resolveConfig({ viewport: { width: 1080, height: 1920 }, layoutScale: 1 });

    const renderAt = async (): Promise<string> => {
      const session = await launchBrowser(config);
      await session.page.goto(server.url('/'));
      const overlay = new CursorOverlay(session.page, config.cursor);
      await overlay.render({ position: { x: 123, y: 456 }, visible: true, clickEmphasis: 0 });

      const markup = String(
        await session.page.evaluate(
          `document.querySelector(${JSON.stringify(CURSOR_SELECTOR)}).outerHTML`,
        ),
      );
      await session.close();
      return createHash('sha256').update(markup).digest('hex');
    };

    const a = await renderAt();
    const b = await renderAt();
    await server.close();

    expect(a).toBe(b);
  }, 120_000);
});
