/**
 * Stock vs Market — compare a stock against the broader indices.
 */

import { createVideo } from '@saltyhasbrown/autovideo';

import {
  DWELL,
  analyseTicker,
  isolateIndex,
  presentIndicator,
  presentSection,
  presentPriceMetric,
} from './beats.js';
import { TID, byTestId, timeframe, indexToggle, signalCard, INDICATOR } from './selectors.js';

const baseUrl = (process.env.SIMPLYSTOCK_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const ticker = (process.env.SIMPLYSTOCK_TICKER ?? 'AAPL').toUpperCase();
const output = process.env.SIMPLYSTOCK_OUTPUT ?? './output/stock-vs-market.mp4';

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
  await video.open(`${baseUrl}/dashboard`);
  await video.waitForSelector(byTestId(TID.marketIndices), { state: 'visible', timeoutMs: 15000 }).catch(() => {});
  await video.mark(`Opening ${ticker}`, { selector: TID.appShell });
  await video.pause(DWELL.short);
});

await video.scene('analyse', async () => {
  await video.waitForSelector('[data-testid="chart-option-include-chart"]', { state: 'visible' });
  await video.cursor.clickSelector('[data-testid="chart-option-include-chart"]');
  await video.pause(DWELL.short);

  await analyseTicker(video, ticker, '3mo', timeframe('3mo'));
});

await video.scene('stock', async () => {
  await presentSection(video, TID.stockChart, 'The stock chart on its own');
  await video.pause(DWELL.short);

  await presentPriceMetric(video, 'current-price', 'Current price');
  await video.pause(DWELL.normal);

  // ADX tells us if the stock is trending at all
  await presentIndicator(video, 'adx', 'Trend strength (ADX)');
  await video.pause(DWELL.normal);
});

await video.scene('market', async () => {
  await presentSection(video, TID.marketIndices, 'The market indices over the same window');
  await video.waitForSelector(byTestId(TID.marketIndices), { state: 'visible', timeoutMs: 15000 }).catch(() => {});
  await video.pause(DWELL.short);

  // Isolate S&P 500 — one line is readable on a phone, three is not
  await isolateIndex(video, 'sp500');
  await video.mark('S&P 500 isolated — the benchmark', { selector: TID.marketIndicesChart });
  await video.pause(DWELL.long);

  // Bring back Nasdaq for comparison
  await video.waitForSelector(indexToggle('nasdaq'), { state: 'visible' });
  await video.cursor.clickSelector(indexToggle('nasdaq'));
  await video.mark('Nasdaq added — tech-heavy comparison', { selector: TID.marketIndicesChart });
  await video.pause(DWELL.normal);

  // Bring back Dow
  await video.waitForSelector(indexToggle('dow'), { state: 'visible' });
  await video.cursor.clickSelector(indexToggle('dow'));
  await video.mark('All three indices — full market context', { selector: TID.marketIndicesChart });
  await video.pause(DWELL.long);
});

await video.scene('outro', async () => {
  await video.scrollTo('body', { behavior: 'instant' });
  await video.mark('Closing — the stock in its market context');
  await video.pause(DWELL.normal);
});

const result = await video.export(output);
await video.dispose();

process.stdout.write(
  `Rendered ${result.path}\n` +
    `  ${result.frames} frames · ${(result.durationMs / 1000).toFixed(1)}s\n`,
);