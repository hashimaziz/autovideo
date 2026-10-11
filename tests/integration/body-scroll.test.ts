import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveConfig } from '../../src/config/config.js';
import { launchBrowser, type BrowserSession } from '../../src/browser/session.js';
import { createActions } from '../../src/browser/actions.js';
import { RESOLVE_SCROLLER_SCRIPT } from '../../src/browser/scrolling.js';
import { createFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

/**
 * Centring on a page that scrolls its BODY rather than the document element.
 *
 * Found by rendering against a real application: the video sat at the top of a 4500px page for its
 * last sixteen seconds while the script believed every scroll had happened. Nothing threw. The
 * scrolls were being clamped to zero.
 *
 * The cause was two disagreeing definitions of "the element that scrolls". Everything else in the
 * module checked BODY first; measurement used `document.scrollingElement`, which reports HTML even
 * on a page that scrolls its BODY. So the centring offset was computed against a container with a
 * scroll limit of zero, and the correct offset was short by exactly the current scroll position.
 */
describe('a page that scrolls its body', () => {
  let server: FixtureServer;
  let session: BrowserSession;
  let actions: ReturnType<typeof createActions>;
  let workDir: string;

  const config = resolveConfig({ viewport: { width: 1080, height: 1920 }, layoutScale: 1 });

  const scroll = () =>
    session.page.evaluate(() => ({
      body: document.body.scrollTop,
      window: window.scrollY,
      bodyLimit: document.body.scrollHeight - document.body.clientHeight,
      htmlLimit: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    }));

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'autovideo-bodyscroll-'));
    server = await createFixtureServer();
    session = await launchBrowser(config);
    await session.page.goto(server.url('/body-scroll.html'));
    actions = createActions({
      page: session.page,
      timeout: config.timeouts.action,
      navigationTimeout: config.timeouts.navigation,
    });
  });

  afterEach(async () => {
    await session?.close();
    await server?.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it('really does scroll its body, and not the document element', async () => {
    // The premise. Without it the rest of this file would pass for the wrong reason.
    const state = await scroll();

    expect(state.bodyLimit).toBeGreaterThan(1000);
    // The trap: documentElement does not scroll, yet scrollingElement still names it.
    expect(state.htmlLimit).toBe(0);
    expect(await session.page.evaluate(RESOLVE_SCROLLER_SCRIPT)).toBe('body');
  });

  it('moves the viewport when asked to scroll to a far element', async () => {
    const target = await session.page.evaluate(() => {
      const rect = document.querySelector('#far-target')!.getBoundingClientRect();
      return rect.top + window.scrollY;
    });
    expect(target).toBeGreaterThan(2000);

    const offset = await actions.offsetToCentre('#far-target');
    expect(offset).not.toBeNull();

    await actions.scrollToOffset(offset!);

    const after = await scroll();
    expect(after.body).toBeGreaterThan(1000);
  });

  it('centres the element rather than merely reaching it', async () => {
    const offset = await actions.offsetToCentre('#far-target');
    await actions.scrollToOffset(offset!);

    // Measured against the viewport, so this is the assertion the old code failed: the offset came
    // back short by the starting scroll position and clamped to zero.
    const centred = await session.page.evaluate(() => {
      const rect = document.querySelector('#far-target')!.getBoundingClientRect();
      return { top: rect.top, height: rect.height, viewport: window.innerHeight };
    });

    const middle = centred.top + centred.height / 2;
    expect(Math.abs(middle - centred.viewport / 2)).toBeLessThan(40);
  });

  it('agrees with its own scroll position on the way down', async () => {
    await actions.scrollToOffset(600);
    expect(await actions.scrollPosition()).toBe(600);

    await actions.scrollToOffset(2400);
    expect(await actions.scrollPosition()).toBe(2400);
  });
});
