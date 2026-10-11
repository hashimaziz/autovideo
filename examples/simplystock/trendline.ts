/**
 * Trendline — draw a trendline on the chart.
 *
 * Opens the chart, enters draw mode, places two points to draw a trendline
 * through recent swing lows, then clears it.
 */

import { createVideo } from '@saltyhasbrown/autovideo';

import {
  DWELL,
  analyseTicker,
  presentSection,
} from './beats.js';
import { TID, byTestId, timeframe } from './selectors.js';

const baseUrl = (process.env.SIMPLYSTOCK_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const ticker = (process.env.SIMPLYSTOCK_TICKER ?? 'AAPL').toUpperCase();
const output = process.env.SIMPLYSTOCK_OUTPUT ?? './output/trendline.mp4';

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

await video.scene('setup', async () => {
  // Bands off so the trendline is the only overlay
  await video.waitForSelector('[data-testid="chart-option-bands"]', { state: 'visible' });
  await video.cursor.clickSelector('[data-testid="chart-option-bands"]');
  await video.pause(DWELL.short);

  await analyseTicker(video, ticker, '6mo', timeframe('6mo'));
  await video.pause(DWELL.short);

  await video.waitForSelector(byTestId(TID.chartPlot), { state: 'visible' });
  await video.scrollTo(byTestId(TID.chartPlot), { behavior: 'natural' });
  await video.mark('Six months of price history, ready to annotate', { selector: TID.chartPlot });
  await video.pause(DWELL.normal);
});

await video.scene('draw', async () => {
  // Enter draw mode
  await video.waitForSelector('[data-testid="draw-trendline"]', { state: 'visible' });
  await video.cursor.moveTo('[data-testid="draw-trendline"]');
  await video.cursor.click();
  await video.mark('Clicking Draw Trend Line — the chart now takes two clicks', { selector: TID.drawTrendline });
  await video.pause(DWELL.short);

  // Click first point (recent swing low)
  await video.waitForSelector('[data-testid="chart-plot"]', { state: 'visible' });
  const plotBox = await video.page.evaluate(() => {
    const el = document.querySelector('[data-testid="chart-plot"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  
  if (plotBox) {
    // First point: ~20% from left, 80% from top (recent swing low area)
    const fx1 = 0.2;
    const fy1 = 0.8;
    await video.page.mouse.move(plotBox.x + plotBox.width * fx1, plotBox.y + plotBox.height * fy1);
    await video.page.mouse.down();
    await video.page.mouse.up();
    await video.mark('Placing the first point on the recent swing low', { selector: TID.chartPlot });
    await video.pause(DWELL.short);

    // Second point: ~80% from left, 30% from top (higher up, drawing line up through lows)
    const fx2 = 0.8;
    const fy2 = 0.3;
    await video.page.mouse.move(plotBox.x + plotBox.width * fx2, plotBox.y + plotBox.height * fy2);
    await video.page.mouse.down();
    await video.page.mouse.up();
    await video.mark('Placing the second point to draw the line up through both lows', { selector: TID.chartPlot });
    await video.pause(DWELL.normal);

    // Verify the line was drawn
    await video.waitForSelector('[data-testid="clear-trendlines"]', { state: 'visible', timeoutMs: 5000 }).catch(() => {});
    await video.mark('Trendline drawn — two points define the support line', { selector: TID.chartPlot });
    await video.pause(DWELL.normal);
  }
});

await video.scene('clear', async () => {
  await video.waitForSelector('[data-testid="clear-trendlines"]', { state: 'visible' });
  await video.cursor.clickSelector('[data-testid="clear-trendlines"]');
  await video.mark('Clearing the trendline', { selector: TID.clearTrendlines });
  await video.pause(DWELL.normal);
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