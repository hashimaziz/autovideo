/**
 * Technical Analysis — rebuild the chart layer by layer.
 *
 * Starts with a bare chart, then toggles on Bollinger Bands, the moving average, and
 * support/resistance lines one at a time so the viewer sees each layer appear.
 */

import { createVideo } from '@saltyhasbrown/autovideo';

import {
  DWELL,
  analyseTicker,
  closeModal,
  enableChartOption,
  presentIndicator,
  presentPriceMetric,
  presentSection,
} from './beats.js';
import { TID, byTestId, timeframe, chartOption, signalCard } from './selectors.js';

const baseUrl = (process.env.SIMPLYSTOCK_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const ticker = (process.env.SIMPLYSTOCK_TICKER ?? 'AAPL').toUpperCase();
const output = process.env.SIMPLYSTOCK_OUTPUT ?? './output/technical-analysis.mp4';

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

await video.scene('chart-setup', async () => {
  // Start with a clean chart: just the price line
  await video.waitForSelector(chartOption('include-chart'), { state: 'visible' });
  await video.cursor.clickSelector(chartOption('include-chart'));
  await video.pause(DWELL.short);

  await analyseTicker(video, ticker, '6mo', timeframe('6mo'));
  await video.pause(DWELL.short);

  // Show bare chart
  await video.scrollTo(byTestId(TID.stockChart), { behavior: 'natural' });
  await video.mark('Price only — the foundation', { selector: TID.stockChart });
  await video.pause(DWELL.normal);

  // Strip overlays to show the bare chart
  await video.waitForSelector(chartOption('bands'), { state: 'visible' });
  await video.cursor.clickSelector(chartOption('bands'));
  await video.cursor.clickSelector(chartOption('ma'));
  await video.cursor.clickSelector(chartOption('support-resistance'));
  await video.pause(DWELL.short);

  await video.scrollTo(byTestId(TID.stockChart), { behavior: 'natural' });
  await video.mark('Stripped to price only', { selector: TID.stockChart });
  await video.pause(DWELL.normal);
});

await video.scene('layers', async () => {
  // Rebuild layer by layer
  for (const option of ['bands', 'ma', 'support-resistance'] as const) {
    await video.waitForSelector(chartOption(option), { state: 'visible' });
    await video.cursor.clickSelector(chartOption(option));
    
    await video.scrollTo(byTestId(TID.stockChart), { behavior: 'natural' });
    const label = option === 'bands'
      ? 'Bollinger Bands layered on'
      : option === 'ma'
        ? '20-day moving average layered on'
        : 'Support and resistance lines layered on';
    await video.mark(label, { selector: TID.stockChart });
    await video.pause(DWELL.normal);
  }
});

await video.scene('levels', async () => {
  await presentPriceMetric(video, 'support-value', 'Support level');
  await video.pause(DWELL.normal);
  await presentPriceMetric(video, 'resistance-value', 'Resistance level');
  await video.pause(DWELL.normal);
});

await video.scene('indicators', async () => {
  for (const key of ['bollinger', 'ma', 'rsi', 'macd', 'volume', 'adx'] as const) {
    await presentIndicator(video, key, `${INDICATOR[key]} reading`);
    await video.pause(DWELL.normal);
  }
});

await video.scene('outro', async () => {
  await video.scrollTo('body', { behavior: 'instant' });
  await video.mark('Closing on the header');
  await video.pause(DWELL.normal);
});

const result = await video.export(output);
await video.dispose();

process.stdout.write(
  `Rendered ${result.path}\n` +
    `  ${result.frames} frames · ${(result.durationMs / 1000).toFixed(1)}s\n`,
);