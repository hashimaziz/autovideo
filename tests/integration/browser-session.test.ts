import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveConfig } from '../../src/config/config.js';
import {
  assertAppReachable,
  launchBrowser,
  type BrowserSession,
} from '../../src/browser/session.js';
import { createFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

/**
 * These launch a real Chromium. They assert observable browser state rather than internal calls,
 * because the point of this layer is that the *page* ends up correct.
 */
describe('chromium session', () => {
  let server: FixtureServer;
  let session: BrowserSession;

  beforeAll(async () => {
    server = await createFixtureServer();
    session = await launchBrowser(resolveConfig({ viewport: 'vertical' }));
    await session.page.goto(server.url('/'));
  });

  afterAll(async () => {
    await session?.close();
    await server?.close();
  });

  it('launches and navigates to a real page', async () => {
    expect(await session.page.title()).toBe('autovideo fixture');
  });

  it('lays out at the layout viewport, not the output viewport', async () => {
    // Capturing at output size would give a 1080x1920 CSS layout, where dashboard text is
    // unreadable. The split is the point of ARCHITECTURE_AUDIT.md §4.1.
    const viewport = session.page.viewportSize();
    expect(viewport).toEqual({ width: 540, height: 960 });
  });

  it('injects the determinism stylesheet on the live page', async () => {
    const duration = await session.page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.transitionDuration = '5s';
      probe.style.animationDuration = '5s';
      probe.style.caretColor = 'red';
      document.body.append(probe);
      const read = {
        transition: getComputedStyle(probe).transitionDuration,
        animation: getComputedStyle(probe).animationDuration,
        caret: getComputedStyle(probe).caretColor,
      };
      probe.remove();
      return read;
    });

    expect(duration.transition).toBe('0s');
    expect(duration.animation).toBe('0s');
    // Chromium reports fully-transparent colours as rgba(0,0,0,0) rather than the keyword.
    expect(duration.caret).toMatch(/^(transparent|rgba\(0,\s*0,\s*0,\s*0\))$/);
  });

  it('leaves the framework overlay exempt from suppression', async () => {
    const duration = await session.page.evaluate(() => {
      const probe = document.createElement('div');
      probe.setAttribute('data-autovideo', 'cursor');
      probe.style.transitionDuration = '250ms';
      document.body.append(probe);
      const read = getComputedStyle(probe).transitionDuration;
      probe.remove();
      return read;
    });

    // The cursor overlay is repositioned every frame and must not be frozen by the blanket rule.
    // Chromium normalises '250ms' to '0.25s', so compare in seconds rather than by string.
    expect(parseFloat(duration)).toBeCloseTo(0.25, 3);
  });

  it('re-applies the stylesheet after a navigation', async () => {
    // Deliberately not memoised: the reference implementation had a module-level cache that
    // silently skipped injection on the recording page after a pre-flight claimed it.
    await session.page.goto(server.url('/other'));

    // Assert the page actually loaded. "transition-duration is 0s" is also true of a 404 page,
    // so without this the test passes against a server that serves nothing.
    expect(await session.page.locator('[data-testid="other-card"]').isVisible()).toBe(true);

    const transition = await session.page.evaluate(`(() => {
      const probe = document.createElement('div');
      probe.style.transitionDuration = '5s';
      document.body.append(probe);
      const read = getComputedStyle(probe).transitionDuration;
      probe.remove();
      return read;
    })()`);

    expect(transition).toBe('0s');
  });

  it('applies caller redaction CSS', async () => {
    const redacted = await launchBrowser(
      resolveConfig({ browser: { extraCss: ['.secret { display: none !important; }'] } }),
    );
    try {
      await redacted.page.goto(server.url('/'));
      const visible = await redacted.page
        .locator('.secret')
        .first()
        .isVisible()
        .catch(() => false);
      expect(visible).toBe(false);
    } finally {
      await redacted.close();
    }
  });

  it('is idempotent on close', async () => {
    const disposable = await launchBrowser(resolveConfig());
    await disposable.close();
    await expect(disposable.close()).resolves.toBeUndefined();
  });

  it('served every requested page', async () => {
    // A 404 page still renders, still has the determinism stylesheet applied, and still
    // satisfies most assertions above. Counting misses makes that failure mode visible.
    expect(server.missing()).toBe(0);
  });
});

describe('assertAppReachable', () => {
  let server: FixtureServer;

  beforeAll(async () => {
    server = await createFixtureServer();
  });

  afterAll(async () => {
    await server?.close();
  });

  it('passes for a live server', async () => {
    await expect(assertAppReachable(server.url('/'))).resolves.toBeUndefined();
  });

  it('reports an unreachable host actionably', async () => {
    // Playwright's own error for this is a connection-refused traceback that never mentions the
    // app; running the check before launch turns a minute of recorded navigation into an error
    // naming the URL.
    await expect(assertAppReachable('http://127.0.0.1:1/', 2000)).rejects.toThrow(
      /Could not reach/,
    );
  });

  it('tells the user what to do', async () => {
    const error = await assertAppReachable('http://127.0.0.1:1/', 2000).catch((e) => e);
    expect(error.hint).toMatch(/Start the application/);
  });
});
