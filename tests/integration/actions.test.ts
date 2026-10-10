import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createActions, type Actions } from '../../src/browser/actions.js';
import { launchBrowser, type BrowserSession } from '../../src/browser/session.js';
import { resolveConfig } from '../../src/config/config.js';
import { VideoActionError } from '../../src/runtime/errors.js';
import { createFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

/**
 * Actions against a real browser and the fixture app.
 *
 * Every assertion is about observable application state — what the DOM says afterwards — rather
 * than about which Playwright call was made.
 *
 * Each test starts from a freshly opened page. An earlier version shared one page across the
 * whole suite, and a single reload that raced a navigation destroyed the execution context and
 * failed fourteen unrelated tests with messages that pointed nowhere near the cause.
 */
describe('actions', () => {
  let server: FixtureServer;
  let session: BrowserSession;
  let actions: Actions;

  const config = resolveConfig({
    viewport: 'vertical',
    timeouts: { action: 5000, navigation: 10_000 },
  });

  /** Read an element's text, whitespace-collapsed. */
  const text = (selector: string) =>
    session.page
      .locator(selector)
      .innerText()
      .catch(() => '');

  beforeAll(async () => {
    server = await createFixtureServer();
    session = await launchBrowser(config);
    actions = createActions({
      page: session.page,
      timeout: config.timeouts.action,
      navigationTimeout: config.timeouts.navigation,
    });
  });

  beforeEach(async () => {
    await actions.open(server.url('/'));
  });

  afterAll(async () => {
    await session?.close();
    await server?.close();
  });

  describe('navigation', () => {
    it('opens a URL', async () => {
      await actions.open(server.url('/other'));

      expect(await session.page.title()).toContain('second page');
      expect(await actions.scrollPosition()).toBe(0);
    });

    it('reloads without leaving the page broken', async () => {
      await actions.reload();

      // A reload that returned before the document was ready would show up here, not as a
      // mysterious failure somewhere downstream.
      await expect(actions.waitForSelector('#ticker')).resolves.toBeUndefined();
      expect(await session.page.title()).toBe('autovideo fixture');
    });
  });

  describe('click', () => {
    it('triggers the application behaviour', async () => {
      await actions.fill('#ticker', 'aapl');
      await actions.click('[data-testid="analyse-button"]');

      await actions.waitForSelector('[data-testid="results"]', { state: 'visible' });
      expect(await text('[data-testid="result-symbol"]')).toBe('AAPL');
    });

    it('reports a hidden element as not visible rather than as a timeout', async () => {
      // Playwright's message for this is "element is outside of the viewport", which reads like
      // a framework bug rather than "you clicked something that is not on screen".
      const error = await actions.click('[data-testid="result-symbol"]').then(
        () => undefined,
        (e: unknown) => e as VideoActionError,
      );

      expect(error?.message).toMatch(/not visible/);
    });

    it('names the selector when the click fails', async () => {
      const error = await actions.click('#does-not-exist').then(
        () => undefined,
        (e: unknown) => e as VideoActionError,
      );

      expect(error?.message).toContain('#does-not-exist');
    });

    it('rejects an empty selector immediately', async () => {
      await expect(actions.click('')).rejects.toThrow(/non-empty selector/);
    });
  });

  describe('typing', () => {
    it('types character by character so the text appears', async () => {
      await actions.type('#ticker', 'MSFT', { delayMs: 5 });

      expect(await session.page.inputValue('#ticker')).toBe('MSFT');
    });

    it('clears the field first by default', async () => {
      await actions.fill('#ticker', 'STALE');
      await actions.type('#ticker', 'NVDA', { delayMs: 5 });

      expect(await session.page.inputValue('#ticker')).toBe('NVDA');
    });

    it('can append without clearing', async () => {
      await actions.fill('#ticker', 'AA');
      await actions.type('#ticker', 'PL', { delayMs: 5, clear: false });

      expect(await session.page.inputValue('#ticker')).toBe('AAPL');
    });

    it('reports a field that does not exist', async () => {
      const error = await actions.type('#nope', 'x').then(
        () => undefined,
        (e: unknown) => e as VideoActionError,
      );

      expect(error?.message).toMatch(/not visible/);
    });
  });

  describe('keyboard and selection', () => {
    it('presses a key on an element', async () => {
      await actions.fill('#ticker', 'TSLA');
      await actions.press('#ticker', 'Enter');

      expect(await session.page.inputValue('#ticker')).toBe('TSLA');
    });

    it('selects an option', async () => {
      await actions.select('#range', 'max');

      expect(await session.page.inputValue('#range')).toBe('max');
    });

    it('lists the available options when a selection fails', async () => {
      const error = await actions.select('#range', 'nope').then(
        () => undefined,
        (e: unknown) => e as VideoActionError,
      );

      expect(error?.message).toContain('nope');
      // The hint must name what *is* available, or the user has to open devtools to find out.
      expect(error?.hint).toContain('1mo');
    });

    it('focuses and hovers', async () => {
      await actions.focus('#ticker');
      expect(await session.page.evaluate(`document.activeElement?.id ?? ''`)).toBe('ticker');

      await expect(actions.hover('[data-testid="analyse-button"]')).resolves.toBeUndefined();
    });
  });

  describe('waits', () => {
    it('resolves when the element appears', async () => {
      await actions.fill('#ticker', 'GOOG');
      await actions.click('[data-testid="analyse-button"]');

      await actions.waitForSelector('[data-testid="results"]', { state: 'visible' });
      expect(await text('[data-testid="result-symbol"]')).toBe('GOOG');
    });

    it('waits for application state rather than a fixed sleep', async () => {
      // The fixture reveals the panel after exactly 300ms. A wait that returned early would be
      // a bug; one that took far longer than 300ms would mean it is not watching state at all.
      await actions.fill('#ticker', 'AMZN');
      await actions.click('[data-testid="analyse-button"]');

      const startedAt = Date.now();
      await actions.waitForSelector('[data-testid="results"]', { state: 'visible' });
      const elapsed = Date.now() - startedAt;

      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(4000);
    });

    it('does not resolve before the element has actually appeared', async () => {
      await actions.fill('#ticker', 'META');
      await actions.click('[data-testid="analyse-button"]');

      const started = Date.now();
      await actions.waitForSelector('[data-testid="results"]', { state: 'visible' });
      const elapsed = Date.now() - started;

      // The panel is revealed after a constant 300ms server-side delay. Resolving sooner would
      // mean the wait is not observing state at all.
      expect(elapsed).toBeGreaterThanOrEqual(250);
    });

    it('reports how long it waited when the element never appears', async () => {
      const error = await actions.waitForSelector('#never-exists', { timeoutMs: 400 }).then(
        () => undefined,
        (e: unknown) => e as VideoActionError,
      );

      expect(error?.message).toContain('#never-exists');
      expect(error?.message).toContain('400ms');
      expect(error?.message).toContain('visible');
    });

    it('waits for a load state', async () => {
      await expect(actions.waitForLoadState('load')).resolves.toBeUndefined();
    });
  });

  describe('scrolling', () => {
    it('detects the scrolling element and reports its offset', async () => {
      // The fixture is 4000px tall in a 960px viewport, so something definitely scrolls.
      await expect(actions.scrollPosition()).resolves.toBe(0);
    });

    it('scrolls to an absolute offset', async () => {
      const result = await actions.scrollToOffset(1200);

      expect(result.to).toBe(1200);
      expect(await actions.scrollPosition()).toBe(1200);
    });

    it('clamps a scroll past the end of the document', async () => {
      // Asking for more than exists must land on the end, not overshoot into nothing.
      const limit = await session.page.evaluate(
        `document.documentElement.scrollHeight - window.innerHeight`,
      );
      const result = await actions.scrollToOffset(1_000_000);

      expect(result.to).toBe(limit);
    });

    it('clamps a negative scroll to the top', async () => {
      await actions.scrollToOffset(500);
      const result = await actions.scrollToOffset(-200);

      expect(result.to).toBe(0);
    });

    it('computes the offset that centres an element', async () => {
      const offset = await actions.offsetToCentre('[data-testid="chart-panel"]');

      expect(offset).not.toBeNull();
      expect(offset as number).toBeGreaterThan(0);

      await actions.scrollToOffset(offset as number);
      const box = await session.page.locator('[data-testid="chart-panel"]').boundingBox();

      // The whole point of the centring maths: after scrolling, the element must actually be on
      // screen. A mis-derived offset scrolls to the wrong place and still looks plausible, which
      // is why the reference implementation verified the landing.
      expect(box).not.toBeNull();
      expect(box?.y).toBeGreaterThan(-5);
      expect(box?.y).toBeLessThan(960);
    });

    it('returns null for an element that does not exist', async () => {
      await expect(actions.offsetToCentre('#nope')).resolves.toBeNull();
    });
  });

  it('served every requested page', async () => {
    // A 404 page renders, has the determinism stylesheet, and satisfies most assertions above.
    // Counting misses makes that silent failure mode visible.
    expect(server.missing()).toBe(0);
  });
});

/**
 * Failures that leave the page unusable get their own browser.
 *
 * Navigating to an unreachable host leaves Playwright on a chrome-error:// page, and every later
 * navigation on a shared page then races it. Keeping destructive tests isolated is what stops
 * one failure from reporting as fifteen unrelated ones.
 */
describe('actions — failure modes', () => {
  it('reports an unreachable URL actionably', async () => {
    const isolated = resolveConfig({
      viewport: 'vertical',
      timeouts: { action: 5000, navigation: 5000 },
    });
    const session = await launchBrowser(isolated);

    try {
      const isolatedActions = createActions({
        page: session.page,
        timeout: isolated.timeouts.action,
        navigationTimeout: isolated.timeouts.navigation,
      });

      const error = await isolatedActions.open('http://127.0.0.1:1/').then(
        () => undefined,
        (e: unknown) => e as VideoActionError,
      );

      expect(error).toBeInstanceOf(VideoActionError);
      expect(error?.message).toContain('127.0.0.1:1');
      expect(error?.hint).toBeTruthy();
    } finally {
      await session.close();
    }
  }, 30_000);
});
