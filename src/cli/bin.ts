/**
 * The `autovideo` command-line entry point.
 *
 * ```sh
 * autovideo render ./demo.ts    # render a video script
 * autovideo inspect ./demo.ts   # print what a script would do, without rendering
 * autovideo doctor [--url URL]  # check that a render could succeed
 * autovideo init [dir]          # scaffold a starter video script
 * ```
 *
 * A video script is an ordinary ES module with a default export that receives the API. It is
 * executed in a child process rather than imported in-process, so a script that crashes takes
 * only itself down, and so `tsx` handles TypeScript without the CLI needing to care.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { VERSION } from '../version.js';
import { flag, intOption, option, parseArgs, unknownOptions, type ParsedArgs } from './args.js';
import { formatChecks, runDoctor } from './doctor.js';

const USAGE = `autovideo ${VERSION}

Create deterministic, polished videos of real web applications.

Usage
  autovideo render <script.ts> [options]   Render a video script to an MP4
  autovideo inspect <script.ts>            List the actions a script would perform
  autovideo doctor [--url <url>]           Check that a render could succeed
  autovideo init [directory]               Write a starter video script

Render options
  -o, --output <path>       Output MP4 path              (default ./output/video.mp4)
      --viewport <name>     vertical | portrait | square | landscape, or 1080x1920
      --fps <n>             Frames per second            (default 30)
      --seed <n>            Seed for all motion          (default 0)
      --layout-scale <n>    Layout zoom factor           (default 2)
      --output-dir <path>   Root for manifests and debug artefacts
      --storage-state <p>   Playwright storageState file for authenticated apps
      --headed              Show the browser window
      --screencast          Record with Playwright's built-in screencast instead of the frame
                            pipeline. Slower, and draws no cursor — kept so the backend
                            comparison in the tests can actually be run.
      --debug-frames        Dump every captured frame on failure (large)

Inspect options
  --url <url>               Base URL to report without launching a browser

Exit codes
  0 success   1 failure   2 bad usage
`;

interface RunOptions {
  output: string;
  outputDir: string;
  viewport: string;
  fps: number;
  seed: number;
  layoutScale: number;
  storageState: string | undefined;
  headed: boolean;
  screencast: boolean;
  debugFrames: boolean;
  url: string | undefined;
}

/** Map parsed arguments to the options the runner uses. */
export function readRunOptions(args: ParsedArgs): RunOptions {
  return {
    output: option(args, 'output', option(args, 'o', './output/video.mp4')),
    outputDir: option(args, 'output-dir', './output'),
    viewport: option(args, 'viewport', 'vertical'),
    fps: intOption(args, 'fps', 30, { min: 1, max: 240 }),
    seed: intOption(args, 'seed', 0),
    layoutScale: intOption(args, 'layout-scale', 2, { min: 1, max: 4 }),
    storageState: args.options['storage-state'],
    headed: flag(args, 'headed'),
    screencast: flag(args, 'screencast'),
    debugFrames: flag(args, 'debug-frames'),
    url: args.options.url,
  };
}

const KNOWN_OPTIONS = [
  'output',
  'o',
  'output-dir',
  'viewport',
  'fps',
  'seed',
  'layout-scale',
  'storage-state',
  'headed',
  'screencast',
  'debug-frames',
  'url',
  'help',
  'h',
  'version',
  'v',
];

/**
 * Execute a video script in a child process.
 *
 * A child rather than an import so a script that throws, hangs, or calls `process.exit` cannot
 * take the CLI — or the diagnostics writer — down with it.
 */
async function executeScript(
  scriptPath: string,
  options: RunOptions,
  mode: 'render' | 'inspect',
): Promise<number> {
  const absoluteScript = resolve(process.cwd(), scriptPath);
  const runner = fileURLToPath(new URL('./script-runner.js', import.meta.url));

  const environment = {
    ...process.env,
    AUTOVIDEO_MODE: mode,
    AUTOVIDEO_OUTPUT: resolve(process.cwd(), options.output),
    AUTOVIDEO_OUTPUT_DIR: resolve(process.cwd(), options.outputDir),
    AUTOVIDEO_VIEWPORT: options.viewport,
    AUTOVIDEO_FPS: String(options.fps),
    AUTOVIDEO_SEED: String(options.seed),
    AUTOVIDEO_LAYOUT_SCALE: String(options.layoutScale),
    AUTOVIDEO_HEADED: options.headed ? '1' : '0',
    AUTOVIDEO_SCREENCAST: options.screencast ? '1' : '0',
    AUTOVIDEO_DEBUG_FRAMES: options.debugFrames ? '1' : '0',
    ...(options.storageState
      ? { AUTOVIDEO_STORAGE_STATE: resolve(process.cwd(), options.storageState) }
      : {}),
  };

  // tsx is a dev dependency of this repo; resolve it relative to the CLI so the command works
  // from a checkout without a global install.
  const tsx = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));

  const child = spawn(process.execPath, [tsx, runner, absoluteScript], {
    stdio: 'inherit',
    env: environment,
  });

  return new Promise((resolvePromise) => {
    child.on('error', (error) => {
      process.stderr.write(`Could not start the script runner: ${error.message}\n`);
      resolvePromise(1);
    });
    child.on('close', (code) => resolvePromise(code ?? 1));
  });
}

/**
 * A starter script, so `init` produces something that runs immediately.
 *
 * Shaped as `export default async (video) => {}` rather than as top-level statements. Two
 * reasons: the script runner passes the API in, so the shape is self-documenting, and top-level
 * await only compiles in a directory whose nearest package.json says `"type": "module"` — so a
 * starter using it would fail on the user's very first run, in a directory we do not control.
 */
const STARTER = `/**
 * A video script.
 *
 * Run it with:  autovideo render video.ts
 * See what it will do without rendering:  autovideo inspect video.ts
 */
export default async function (video) {
  const url = process.env.AUTOVIDEO_TARGET_URL ?? 'https://example.com';

  await video.scene('open', async () => {
    await video.open(url);
    await video.pause(1000);
  });

  await video.scene('interact', async () => {
    await video.cursor.moveTo('a');
    await video.cursor.click();
    await video.pause(600);

    await video.scrollTo('body', { behavior: 'natural' });
    await video.pause(800);
  });

  const result = await video.export();
  console.log('Rendered', result.path);
}
`;

async function commandInit(target: string | undefined): Promise<number> {
  const directory = resolve(process.cwd(), target ?? '.');
  await mkdir(directory, { recursive: true });

  const scriptPath = resolve(directory, 'video.ts');
  await writeFile(scriptPath, STARTER, 'utf8');

  process.stdout.write(
    `Wrote ${scriptPath}\n\nNext:\n  autovideo doctor --url ${urlForStarter()}\n  autovideo render ${scriptPath}\n`,
  );
  return 0;
}

function urlForStarter(): string {
  return process.env.AUTOVIDEO_TARGET_URL ?? 'https://example.com';
}

/** Entry point. Returns a process exit code rather than calling `process.exit`. */
export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const command = args.positionals[0];

  if (flag(args, 'version') || flag(args, 'v')) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (!command || flag(args, 'help') || flag(args, 'h') || command === 'help') {
    process.stdout.write(USAGE);
    return command || flag(args, 'help') || flag(args, 'h') ? 0 : 2;
  }

  const unknown = unknownOptions(args, KNOWN_OPTIONS);
  if (unknown.length > 0) {
    process.stderr.write(
      `Unknown option${unknown.length > 1 ? 's' : ''}: ${unknown.map((name) => `--${name}`).join(', ')}\n\nRun \`autovideo --help\`.\n`,
    );
    return 2;
  }

  const options = readRunOptions(args);

  switch (command) {
    case 'doctor': {
      const { checks, ok } = await runDoctor({
        config: {
          viewport: options.viewport,
          fps: options.fps,
          seed: options.seed,
          layoutScale: options.layoutScale,
          output: options.output,
          outputDir: options.outputDir,
          ...(options.storageState ? { browser: { storageState: options.storageState } } : {}),
        },
        url: options.url,
      });

      process.stdout.write(`\nautovideo doctor\n\n${formatChecks(checks)}\n\n`);
      if (ok) {
        process.stdout.write('Everything checks out.\n');
      } else {
        process.stdout.write('Some checks failed — see the fixes above.\n');
      }
      return ok ? 0 : 1;
    }

    case 'init':
      return commandInit(args.positionals[1]);

    case 'inspect':
    case 'render': {
      const script = args.positionals[1];
      if (!script) {
        process.stderr.write(`\`autovideo ${command}\` needs a script path.\n\n${USAGE}`);
        return 2;
      }
      return executeScript(script, options, command);
    }

    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
}

/** Run the CLI. Only executed when this module is the entry point. */
export async function run(argv: readonly string[]): Promise<void> {
  try {
    process.exitCode = await main(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

// Only auto-run when invoked directly, so tests can import `main` without side effects.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  void run(process.argv.slice(2));
}
