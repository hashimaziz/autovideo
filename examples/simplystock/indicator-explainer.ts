/**
 * Indicator Explainer — walk through each indicator with its guide entry.
 */

import { createVideo } from '@saltyhasbrown/autovideo';

import {
  DWELL,
  analyseTicker,
  closeModal,
  openGuideEntry,
  presentIndicator,
  presentSection,
} from './beats.js';
import { INDICATOR, TID, byTestId, timeframe, signalCard } from './selectors.js';

const baseUrl = (process.env.SIMPLYSTOCK_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const ticker = (process.env.SIMPLYSTOCK_TICKER ?? 'AAPL').toUpperCase();
const output = process.env.SIMPLYSTOCK_OUTPUT ?? './output/indicator-explainer.mp4';

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

// Indicator / guide pairs to walk through
const EXPLANATIONS = [
  { indicator: 'ma', guide: 'Moving Average' },
  { indicator: 'bollinger', guide: 'Bollinger Bands' },
  { indicator: 'rsi', guide: 'RSI' },
  { indicator: 'macd', guide: 'MACD' },
  { indicator: 'volume', guide: 'Volume' },
] as const;

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
  await analyseTicker(video, ticker, '3mo', timeframe('3mo'));
});

await video.scene('indicators', async () => {
  for (const { indicator, guide } of EXPLANATIONS) {
    await presentIndicator(video, indicator, `${INDICATOR[indicator]} reading`);
    await video.pause(DWELL.normal);

    await openGuideEntry(video, guide, `What ${INDICATOR[indicator]} means`);
    await video.pause(DWELL.long);

    await closeModal(video);
    await video.pause(DWELL.short);
  }
});

await video.scene('outro', async () => {
  await video.scrollTo('body', { behavior: 'instant' });
  await video.mark('Closing — every indicator has a guide entry');
  await video.pause(DWELL.normal);
});

const result = await video.export(output);
await video.dispose();

process.stdout.write(
  `Rendered ${result.path}\n` +
    `  ${result.frames} frames · ${(result.durationMs / 1000).toFixed(1)}s\n`,
);