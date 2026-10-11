/**
 * Natural cursor movement, typing and scrolling.
 *
 *   AUTOVIDEO_TARGET_URL=https://yourapp.com \
 *     autovideo render examples/natural-input/natural-input.ts
 *
 * What makes motion look deliberate rather than mechanical:
 *
 * - Cursor travel time scales with distance. A 4px correction and a full-frame sweep do not
 *   take the same time, and using one duration for both is the tell of a fake cursor.
 * - Easing accelerates and decelerates, so the pointer arrives rather than stopping dead.
 * - Typing jitters its inter-key interval and occasionally pauses mid-thought.
 * - Scrolling has the same easing, and lands exactly on its target.
 *
 * All of it is drawn from seeded RNG streams, so the same seed reproduces the same motion
 * exactly — natural-looking and reproducible are not in tension.
 *
 * There are deliberately **no typos**. A natural mode that occasionally types a wrong character
 * is worse than an even one, because the viewer sees a mistake the application never made.
 */
export default async function (video) {
  const url = process.env.AUTOVIDEO_TARGET_URL ?? 'https://example.com';

  await video.open(url);
  await video.pause(600);

  // Approach the field from off to the side, the way a hand does.
  await video.cursor.moveToPoint(120, 200);
  await video.pause(200);
  await video.cursor.moveTo('#search');
  await video.cursor.click();

  await video.type('#search', 'MSFT', { behavior: 'natural', speed: 90, variance: 0.45 });
  await video.press('#search', 'Enter');
  await video.pause(1000);

  // Scroll as a single continuous move rather than a jump.
  await video.scroll({ amount: 800, behavior: 'natural' });
  await video.pause(900);
  await video.scroll({ amount: -400, behavior: 'natural' });
  await video.pause(900);

  await video.cursor.hide();
  await video.pause(400);

  const result = await video.export();
  console.log(`Rendered ${result.path} — ${result.frames} frames`);
}
