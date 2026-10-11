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

import { createVideo, setVideoFactory } from '../video/index.js';
import type { VideoConfigInput } from '../config/config.js';
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
 * Load the user's script.
 *
 * Two styles are supported, and both are ordinary:
 *
 * - `export default async (video) => { … }` — the runner passes the API in.
 * - Top-level statements that build their own session with `createVideo()` and call
 *   `video.export()` themselves. Importing such a module *is* running it, because of its
 *   top-level await, so there is nothing left to invoke.
 *
 * Returning a no-op for the second style is what lets one CLI serve both. If someone forgets the
 * default export and writes the first style, inspection comes back empty and says so, which is a
 * far better failure than refusing to load their file.
 */
async function loadScript(path: string): Promise<LoadedScript> {
  const module = (await import(path)) as { default?: unknown };

  if (typeof module.default !== 'function') {
    // Top-level await already ran the script, so there is nothing left to invoke.
    return { run: async () => undefined, selfDriven: true };
  }

  return { run: module.default as ScriptEntry, selfDriven: false };
}

/**
 * A script's default export.
 *
 * Both shapes are supported: one that takes the API, and one that takes nothing and imports
 * `createVideo` itself. JavaScript cannot express that difference in one signature, so the
 * argument is optional at the type level and simply ignored when unused.
 */
type ScriptEntry = (api?: unknown) => Promise<unknown>;

/** A loaded script, and which of the two styles it turned out to be written in. */
interface LoadedScript {
  run: ScriptEntry;
  /** True when the script built its own session and exported its own video. */
  selfDriven: boolean;
}

/** Exposed for the unit suite. Wraps the private loader without exposing its internals. */
export async function loadScriptForTest(path: string): Promise<LoadedScript> {
  return loadScript(path);
}

async function main(): Promise<number> {
  const scriptPath = process.argv[2];
  if (!scriptPath) {
    process.stderr.write('No script path given.\n');
    return 2;
  }

  const config = readConfig();

  // Inspection has to be installed *before* the script is imported, because a script is free to
  // call createVideo() itself — the shape the plan's own example uses — and would otherwise launch
  // a browser. With the factory overridden, both script styles walk without rendering.
  const inspection = mode === 'inspect' ? await prepareInspection(config) : undefined;

  const { run, selfDriven } = await loadScript(scriptPath);

  if (inspection) {
    // A script written as `export default async (video) => {}` receives the recorder directly.
    // One that builds its own session has already populated the same recorder via the factory.
    await run(inspection.recorder.video);
    inspection.print();
    return 0;
  }

  if (selfDriven) {
    // The script already created its session and called export() itself, at import time. Creating
    // one here as well launched a second browser, rendered an empty about:blank page through it,
    // and then failed with "Output file does not contain any stream" — after the real video had
    // already been written and the command had already reported success. It also doubled the
    // memory and roughly doubled the wall-clock time of every self-driving render.
    if (process.env.AUTOVIDEO_OUTPUT) {
      process.stderr.write(
        'Note: --output is ignored for scripts that build their own video with createVideo().\n' +
          'The script chooses its own output path; set it in the script or via its own env vars.\n',
      );
    }

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

/**
 * Prepare inspection: swap in a recording factory and silence the script's own output.
 *
 * Scripts end with `console.log('Rendered …')`, which is noise in an inspection whose whole
 * purpose is to list operations rather than claim a video was produced.
 */
async function prepareInspection(config: VideoConfigInput) {
  const { createInspectionRecorder, printInspection } = await import('./inspect.js');
  const recorder = createInspectionRecorder(config);

  setVideoFactory(async (input) => {
    // The script's own config wins where it supplies one; CLI flags fill the rest.
    const merged = createInspectionRecorder({ ...config, ...input });
    recorder.actions.push(...merged.actions);
    return recorder.video as never;
  });

  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;

  return {
    recorder,
    print(): void {
      process.stdout.write = write as typeof process.stdout.write;
      printInspection(recorder.actions, config);
    },
  };
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
