/**
 * The smallest complete autovideo script.
 *
 *   autovideo inspect examples/basic/basic.ts
 *   autovideo render  examples/basic/basic.ts -o ./output/basic.mp4
 *
 * Set the target with:
 *   AUTOVIDEO_TARGET_URL=https://yourapp.com autovideo render examples/basic/basic.ts
 *
 * The script receives the API rather than importing it, which is the convention the runner
 * expects: a script is a default export that takes one argument.
 */
export default async function (video) {
  const url = process.env.AUTOVIDEO_TARGET_URL ?? 'https://example.com';

  await video.open(url);

  await video.cursor.moveTo('a');
  await video.cursor.click();
  await video.pause(800);

  const result = await video.export();
  console.log(`Rendered ${result.path} — ${result.frames} frames`);
}
