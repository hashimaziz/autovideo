/**
 * Runs a user video script inside a child process.
 *
 * The CLI spawns this rather than importing the script itself, so a script that throws, hangs,
 * or calls `process.exit` cannot take the CLI — or its diagnostics — down with it.
 *
 * Configuration arrives through the environment rather than argv, because a script path may
 * contain spaces and because `AUTOVIDEO_*` names are self-describing in a crash report.
 *
 * Deliberately does **not** execute anything the user did not ask for. A video script is
 * arbitrary code by nature, which is why the README says so plainly.
 */

import { writeFile } from 'node:fs/promises';

import { createVideo } from '../video/index.js';
import { VideoRenderError } from '../runtime/render-error.js';

const mode = (process.env.AUTOVIDEO_MODE ?? 'render') as 'render' | 'inspect';

/** Read configuration out of the environment. */
function readConfig() {
  return {
    viewport: process.env.AUTOVIDEO_VIEWPORT ?? 'vertical',
    fps: process.env.AUTOVIDEO_FPS ? Number.parseInt(process.env.AUTOVIDEO_FPS, 10) : 30,
    seed: process.env.AUTOVIDEO_SEED ? Number.parseInt(process.env.AUTOVIDEO_SEED, 10) : 0,
    layoutScale: process.env.AUTOVIDEO_LAYOUT_SCALE
      ? Number.parseInt(process.env.AUTOVIDEO_LAYOUT_SCALE, 10)
      : 2,
    output: process.env.AUTOVIDEO_OUTPUT ?? './output/video.mp4',
    outputDir: process.env.AUTOVIDEO_OUTPUT_DIR ?? './output',
    ...(process.env.AUTOVIDEO_STORAGE_STATE
      ? { browser: { storageState: process.env.AUTOVIDEO_STORAGE_STATE } }
      : {}),
    ...(process.env.AUTOVIDEO_HEADED === '1' ? { browser: { headless: false } } : {}),
    ...(process.env.AUTOVIDEO_SCREENCAST === '1'
      ? { recorder: { backend: 'screencast' as const } }
      : {}),
    ...(process.env.AUTOVIDEO_DEBUG_FRAMES === '1' ? { debug: { frames: true } } : {}),
  };
}

/**
 * Locate the user's script.
 *
 * The conventional shape is a default export that takes the API. A default export taking no
 * arguments is also accepted, so a script can `import { createVideo }` itself.
 */
async function loadScript(path: string): Promise<ScriptEntry> {
  const module = (await import(path)) as { default?: unknown };

  if (typeof module.default !== 'function') {
    throw new Error(
      `${path} must have a default export that is a function, e.g. ` +
        `\`export default async (video) => { ... }\`.`,
    );
  }

  return module.default as ScriptEntry;
}

/**
 * A script's default export.
 *
 * Both shapes are supported: one that takes the API, and one that takes nothing and imports
 * `createVideo` itself. JavaScript cannot express that difference in one signature, so the
 * argument is optional at the type level and simply ignored when unused.
 */
type ScriptEntry = (api?: unknown) => Promise<unknown>;

async function main(): Promise<number> {
  const scriptPath = process.argv[2];
  if (!scriptPath) {
    process.stderr.write('No script path given.\n');
    return 2;
  }

  const config = readConfig();
  const run = await loadScript(scriptPath);

  if (mode === 'inspect') {
    // Inspecting runs the script with a recording object that records instead of rendering, so
    // the browser is never launched. That keeps `autovideo inspect` fast and side-effect free,
    // which is what makes it useful for checking a script's structure.
    const { createInspectionRecorder, printInspection } = await import('./inspect.js');
    const recorder = createInspectionRecorder(config);
    await run(recorder.video);
    printInspection(recorder.actions, config);
    return 0;
  }

  const video = await createVideo(config);

  try {
    await run(video);
  } catch (error) {
    await report(error);
    await video.dispose();
    return 1;
  }

  try {
    const result = await video.export();

    // The manifest is the record of *why* this video looks the way it does. Written here rather
    // than only on failure so a successful render is still reproducible after the fact.
    const manifest = video.manifest();
    await writeFile(
      `${result.path.replace(/\.mp4$/, '')}.manifest.json`,
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    ).catch(() => undefined);

    await video.dispose();

    process.stdout.write(
      `\nRendered ${result.path}\n` +
        `  ${result.frames} frames · ${(result.durationMs / 1000).toFixed(2)}s of video · ` +
        `${(result.renderMs / 1000).toFixed(1)}s to render` +
        (result.throughput > 0 ? ` (${result.throughput.toFixed(2)}x realtime)\n` : '\n'),
    );
    return 0;
  } catch (error) {
    await report(error);
    await video.dispose();
    return 1;
  }
}

/** Print a failure in the form the user can act on. */
async function report(error: unknown): Promise<void> {
  if (error instanceof VideoRenderError) {
    process.stderr.write(`\nRender failed.\n\n${error.report()}\n\n`);
    return;
  }
  process.stderr.write(
    `\nRender failed.\n\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n\n`,
  );
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
