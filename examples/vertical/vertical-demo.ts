/**
 * A full vertical product demo — the shape most social video takes.
 *
 *   AUTOVIDEO_TARGET_URL=https://yourapp.com \
 *     autovideo render examples/vertical/vertical-demo.ts \
 *       --viewport vertical --fps 60 --seed 42069 -o ./output/demo.mp4
 *
 * The scene structure is the point of this example. Scenes give the manifest a readable shape,
 * which is what makes a failed render diagnosable and what a later narration tool would read.
 *
 * Replace the selectors with your own; the structure carries over unchanged.
 */
export default async function (video) {
  const url = process.env.AUTOVIDEO_TARGET_URL ?? 'https://example.com';

  await video.scene('open', async () => {
    await video.open(url);
    // Long enough for the viewer to register what they are looking at.
    await video.pause(1200);
  });

  await video.scene('search', async () => {
    await video.cursor.moveTo('#ticker-search');
    await video.cursor.click();

    await video.type('#ticker-search', 'AAPL', { behavior: 'natural' });
    await video.press('#ticker-search', 'Enter');

    // Waiting on state, not on a sleep. The video length is whatever the app actually took.
    await video.waitForSelector('#results', { state: 'visible' });
    await video.pause(1400);
  });

  await video.scene('analysis', async () => {
    await video.scrollTo('#chart', { behavior: 'natural' });
    await video.pause(1500);

    await video.scrollTo('#indicators', { behavior: 'natural' });
    await video.pause(1200);

    // A beat in the manifest: what is on screen, and roughly when.
    await video.mark('Chart in view', { selector: '#chart' });
  });

  const result = await video.export();
  console.log(
    `Rendered ${result.path} — ${result.frames} frames, ` +
      `${(result.durationMs / 1000).toFixed(1)}s of video in ${(result.renderMs / 1000).toFixed(1)}s`,
  );
}
