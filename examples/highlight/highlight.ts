/**
 * Highlighting — telling the viewer where to look without saying anything.
 *
 * Run it:
 *
 *   npx autovideo render examples/highlight/highlight.ts
 *
 * The problem this solves is subtler than it looks. A product video has to direct attention to
 * individual readings on a screen, and the only tool most tools offer is the mouse pointer. Point
 * at a number and the viewer looks at the pointer. Highlight the same number and the viewer looks
 * at the number — while the cursor, your narration and the previous beat all still have somewhere
 * to be.
 *
 * So in practice you want both, and to switch between them: highlight the panel, then move the
 * cursor to the one value in it that you are about to talk about.
 */

import { createVideo } from '../../src/video/index.js';

const video = await createVideo({
  viewport: 'vertical',
  fps: 30,
  seed: 7,
});

await video.open('http://localhost:3000/dashboard');

await video.scene('point-at-a-panel', async () => {
  // Ring the whole panel. One gesture covers every value inside it, so the viewer knows where
  // they are before any individual number is discussed.
  await video.highlight('[data-testid="price-summary"]');
  await video.pause(1200);
  video.mark('The panel, as a whole');
});

await video.scene('narrow-to-one-value', async () => {
  // Highlighting moves rather than stacking, so there is never a moment with two rings on screen
  // and a question about which one is meant.
  await video.highlight('[data-testid="current-price"]', { color: '#4ade80' });
  await video.pause(1400);
  video.mark('Where the stock is trading now', { selector: 'current-price' });
});

await video.scene('let-it-go', async () => {
  // The ring fades out on its own after its duration, which is what a self-contained beat wants:
  // no need to pair every highlight with a matching clear.
  await video.highlight('[data-testid="atr-value"]', {
    color: '#60a5fa',
    durationMs: 1500,
  });

  // …and meanwhile the cursor gets on with pointing at the next thing.
  await video.cursor.moveTo('[data-testid="resistance-value"]', { behavior: 'natural' });
  await video.pause(1800);
});

await video.scene('outline-only', async () => {
  // A transparent fill gives an outline, which is the quieter option for something already
  // surrounded by other content. Good for dense tables, where a tinted box fights the data.
  await video.highlight('[data-testid="signal-grid"]', {
    fill: 'transparent',
    borderWidth: 2,
    padding: 10,
    radius: 16,
  });
  await video.pause(1500);
  await video.clearHighlight();
});

const result = await video.export();

process.stdout.write(`Wrote ${result.path} (${result.frames} frames)\n`);
