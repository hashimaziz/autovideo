/**
 * Stock Overview — the stock_overview workflow, rebuilt on autovideo.
 *
 * This is the test of the framework's central claim: that this production workflow can be
 * reproduced using only autovideo's public API, with no app-specific assumptions baked into the
 * engine. It lives here, in the application repo, precisely because that is where it belongs —
 * every selector below is application knowledge, and the framework knows none of it.
 *
 * Run it with:
 *
 *   SIMPLYSTOCK_STORAGE_STATE=./storage-state.json SIMPLYSTOCK_OUTPUT=./output/AAPL.mp4 \
 *     npx autovideo render autovideo-port/stock-overview.ts
 *
 * Set SIMPLYSTOCK_URL and SIMPLYSTOCK_TICKER to target a different host or symbol.
 *
 * ### What this demonstrates
 *
 * The original was ~120 lines of Playwright helpers plus a template. This is one file that calls
 * only public API. Things that were manual work in the original are now the framework's job:
 *
 * - **The cursor is drawn and moves.** The original had to call `mouse.move()` before every
 *   interaction and hope a screencast captured it. It did not — the audit proved Playwright's
 *   screencast draws no cursor. Here `video.cursor.moveTo()` is interpolated and composited.
 * - **Scrolls are animated.** `centerOn` plus a hand-rolled `easeInOutCubic` loop becomes
 *   `video.scrollTo(selector, { behavior: 'natural' })`, which also verifies the element actually
 *   landed on screen rather than reporting success for a mis-derived target.
 * - **Timing is in frames, not sleeps.** `settle(page, 'long')` becomes `video.pause(...)`.
 *   Because logical time advances only as frames are captured, a 1300ms pause renders exactly
 *   39 frames at 30fps on any machine — a machine-dependent pause would make renders differ.
 * - **Diagnostics are free.** A failed step produces a screenshot, a Playwright trace, console
 *   and network logs, and a manifest naming the scene and selector that failed.
 *
 * ### What is unchanged
 *
 * The app knowledge. Selector strings, indicator names and routes are still required, because no
 * framework can guess what an application calls its own DOM. They all live in `selectors.ts`,
 * which is the only file that needs editing to retarget this script.
 */

import { createVideo } from 'autovideo';
import { INDICATOR, PATH, TID, byTestId, chartOption, signalCard, timeframe } from './selectors.js';

const baseUrl = (process.env.SIMPLYSTOCK_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const ticker = (process.env.SIMPLYSTOCK_TICKER ?? 'AAPL').toUpperCase();
const period = process.env.SIMPLYSTOCK_PERIOD ?? '3mo';

// A script that builds its own video chooses its own output path; the CLI's --output flag cannot
// reach it. SIMPLYSTOCK_OUTPUT is the equivalent.
const output = process.env.SIMPLYSTOCK_OUTPUT ?? './output/stock-overview.mp4';

const video = await createVideo({
  viewport: 'vertical',
  fps: 30,
  // A fixed seed, so re-rendering produces the same motion rather than a subtly different video.
  seed: 42069,
  browser: {
    // A Playwright storageState file, not a persistent Chrome profile: the framework never reads
    // its contents, so session cookies cannot leak into a manifest or a debug artefact.
    ...(process.env.SIMPLYSTOCK_STORAGE_STATE
      ? { storageState: process.env.SIMPLYSTOCK_STORAGE_STATE }
      : {}),
    // The account email and the personal portfolio/watchlist modules are the user's data, not
    // anything a viewer should see. Hiding them is configuration, not engine code.
    extraCss: [
      '.user-email { display: none !important; }',
      '[data-testid="portfolio-section"] { display: none !important; }',
      '[data-testid="watchlist-section"] { display: none !important; }',
    ],
  },
});

await video.scene('open', async () => {
  await video.open(`${baseUrl}${PATH.dashboard}`);

  // The market-indices panel sits above the analysis and shows a spinner while it loads. Waiting
  // for it means the opening frames never catch it mid-load, which reads as a broken product.
  //
  // Tolerant on purpose: a template that does not feature the indices should not fail because
  // they did not load.
  await video
    .waitForSelector(byTestId(TID.marketIndices), { state: 'visible', timeoutMs: 15_000 })
    .catch(() => undefined);

  await video.scrollTo('body', { behavior: 'natural' });
  await video.pause(700);
  video.mark('Dashboard loaded', { selector: TID.appShell });
});

await video.scene('chart-options', async () => {
  // Silent setup in the original, and still silent here: no camera move, no mark. Turning on the
  // overlays is not a beat, it is a precondition for the beats that follow.
  for (const option of ['bands', 'ma', 'support-resistance']) {
    await video.cursor.clickSelector(chartOption(option));
  }
  await video.pause(400);
});

await video.scene('analyse', async () => {
  // A visible action that changes the chart, so it earns its own beat.
  await video.cursor.clickSelector(timeframe(period));
  video.mark(`Switched to ${period}`, { selector: TID.timeframeButton });
  await video.pause(600);

  // The input arrives pre-filled with the dashboard's default ticker, and `type` appends to
  // whatever is already there — so typing 'AAPL' into it produced 'AAPLAAPL', which the analyse
  // endpoint rejected with "No data found, symbol may be delisted" and a 500. Clearing first is
  // what a person does when retyping a field, so it is both correct and the honest gesture.
  //
  // ControlOrMeta rather than Meta, so the script does not become a macOS-only script.
  await video.cursor.clickSelector(byTestId(TID.tickerInput));
  await video.press(byTestId(TID.tickerInput), 'ControlOrMeta+A');
  await video.press(byTestId(TID.tickerInput), 'Backspace');
  await video.type(byTestId(TID.tickerInput), ticker, { behavior: 'natural', speed: 110 });

  await video.cursor.clickSelector(byTestId(TID.analyzeButton));

  // Wait on application state, never on a sleep. The API call's duration is the app's, not ours,
  // and the video shows whatever that turned out to be.
  await video.waitForSelector(byTestId(TID.analysisResults), {
    state: 'visible',
    timeoutMs: 30_000,
  });
  await video.pause(900);
});

await video.scene('price-summary', async () => {
  await video.scrollTo(byTestId(TID.priceSummary), { behavior: 'natural' });
  await video.pause(1400);
  video.mark('Price, support, resistance and volatility at a glance', {
    selector: TID.priceSummary,
  });

  // Walk the individual readings. Each gets the cursor arriving first, so the viewer is shown
  // where to look rather than being told.
  for (const [name, label] of [
    [TID.currentPrice, 'Where the stock is trading now'],
    [TID.overallSignal, 'The overall technical verdict'],
    [TID.supportValue, 'Support'],
    [TID.resistanceValue, 'Resistance'],
    [TID.atrValue, 'Average true range — how much it moves in a normal day'],
  ] as const) {
    await video.cursor.clickSelector(byTestId(name));
    video.mark(label, { selector: name });
    await video.pause(1100);
  }
});

await video.scene('signals', async () => {
  await video.scrollTo(byTestId(TID.signalGrid), { behavior: 'natural' });
  await video.pause(800);

  // Signal cards are addressed by the indicator name the app renders.
  for (const [key, label] of [
    [INDICATOR.ma, 'Moving-average crossover tells you which way the trend leans'],
    [INDICATOR.rsi, 'RSI shows whether the stock is overbought or oversold'],
  ] as const) {
    await video.cursor.clickSelector(signalCard(key));
    video.mark(label, { selector: TID.signalCard });
    await video.pause(1200);
  }
});

await video.scene('playbooks', async () => {
  // Show there is more beneath the summary without dwelling on it.
  await video.scrollTo(byTestId(TID.strategySection), { behavior: 'natural' });
  await video.pause(1500);
  video.mark('Named playbooks are checked against this stock', {
    selector: TID.strategySection,
  });
});

await video.scene('outro', async () => {
  // Bookend: the same frame the video opened on.
  await video.scrollTo('body', { behavior: 'natural' });
  await video.pause(1200);
  video.mark('Closing on the SimplyStock header');
});

const result = await video.export(output);

process.stdout.write(
  `Rendered ${result.path}\n` +
    `  ${result.frames} frames · ${(result.durationMs / 1000).toFixed(1)}s of video · ` +
    `${(result.renderMs / 1000).toFixed(1)}s to render\n`,
);
