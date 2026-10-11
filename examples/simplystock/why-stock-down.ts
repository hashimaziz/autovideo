/**
 * Why is this stock moving?
 *
 * Verdict, price context, the momentum indicators that explain most intraday moves, the playbook
 * section, then the indicator guide so viewers can look up what they just saw.
 *
 * Works for a stock that is rising as well as one that is falling: nothing here branches on
 * direction, it presents whatever the indicators say.
 */

import { createVideo } from '@saltyhasbrown/autovideo';

import {
  DWELL,
  analyseTicker,
  closeModal,
  openGuideEntry,
  prepareDashboard,
  presentIndicator,
  presentPlaybooks,
  presentPriceMetric,
  presentSection,
} from './beats.js';
import { TID, timeframe } from './selectors.js';

const baseUrl = (process.env.SIMPLYSTOCK_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const ticker = (process.env.SIMPLYSTOCK_TICKER ?? 'AAPL').toUpperCase();
const output = process.env.SIMPLYSTOCK_OUTPUT ?? './output/why-stock-down.mp4';

const video = await createVideo({
  viewport: 'vertical',
  fps: 30,
  seed: 42069,
  browser: {
    ...(process.env.SIMPLYSTOCK_STORAGE_STATE
      ? { storageState: process.env.SIMPLYSTOCK_STORAGE_STATE }
      : {}),
    extraCss: [
      '.user-email { display: none !important; }',
      '[data-testid="portfolio-section"] { display: none !important; }',
      '[data-testid="watchlist-section"] { display: none !important; }',
      '[data-testid="news-sidebar"] { display: none !important; }',
    ],
  },
});

await video.scene('open', async () => {
  // Opened here rather than above the scenes: prepareDashboard measures the page, and there is
  // nothing to measure on about:blank.
  await video.open(`${baseUrl}/dashboard`);
  await prepareDashboard(video);
  await video.mark(`Opening ${ticker}`, { selector: TID.appShell });
  await video.pause(DWELL.short);
});

await video.scene('analyse', async () => {
  await analyseTicker(video, ticker, '3mo', timeframe('3mo'));
});

await video.scene('verdict', async () => {
  // The banner carries the whole conclusion, so it gets the longest dwell.
  await presentSection(video, TID.overallSignal, 'The technical verdict across all indicators');
  await video.pause(DWELL.long);
});

await video.scene('price', async () => {
  await presentPriceMetric(video, 'current-price', `Latest price for ${ticker}`);
  await video.pause(DWELL.normal);

  // The pair that explains most intraday moves, plus volume to confirm it.
  for (const indicator of ['rsi', 'macd', 'volume'] as const) {
    await presentIndicator(video, indicator, `${indicator.toUpperCase()} reading`);
    await video.pause(DWELL.normal);
  }
});

await video.scene('levels', async () => {
  await presentPriceMetric(video, 'support-value', 'Support level to watch on a pullback');
  await video.pause(DWELL.short);

  await presentPriceMetric(video, 'resistance-value', 'Resistance level to watch on a rally');
  await video.pause(DWELL.normal);
});

await video.scene('playbooks', async () => {
  await presentPlaybooks(video);
  await video.pause(DWELL.long);
});

await video.scene('guide', async () => {
  await openGuideEntry(video, 'Bollinger Bands', 'What Bollinger Bands measure');
  await video.pause(DWELL.long);
  await closeModal(video);
});

await video.scene('outro', async () => {
  await video.scrollTo('body', { behavior: 'instant' });
  await video.mark('Closing on the header');
  await video.pause(DWELL.normal);
});

const result = await video.export(output);
await video.dispose();
process.stdout.write(
  `Rendered ${result.path}\n  ${result.frames} frames · ${(result.durationMs / 1000).toFixed(1)}s\n`,
);
