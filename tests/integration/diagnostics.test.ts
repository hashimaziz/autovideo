import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createVideo } from '../../src/video/index.js';
import { VideoRenderError, formatDuration } from '../../src/runtime/render-error.js';
import { BrowserLog } from '../../src/runtime/diagnostics.js';
import { createFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

/**
 * Debugging artefacts.
 *
 * The claim under test is the plan's §40: "a failed video can be diagnosed without manually
 * reproducing it". A VideoError that says "TimeoutError" does not satisfy that. These assert
 * that the artefacts exist, are populated, and are named in the error.
 */

/**
 * Locate the timestamped directory a failed run wrote into.
 *
 * Artefacts are nested as debug/<run-stamp>/ so consecutive failures do not overwrite each
 * other, which means tests have to descend two levels rather than one.
 */
async function findRunDir(videoDir: string): Promise<string> {
  const debugDir = join(videoDir, 'debug');
  const entries = await readdir(debugDir);
  const stamp = entries.find((entry) => /^\d{4}-\d{2}-\d{2}T/.test(entry));

  expect(stamp, `no run directory under ${debugDir}`).toBeDefined();
  return join(debugDir, stamp as string);
}

describe('failure diagnostics', () => {
  let server: FixtureServer;
  let workDir: string;

  beforeAll(async () => {
    server = await createFixtureServer();
    workDir = await mkdtemp(join(tmpdir(), 'autovideo-debug-'));
  });

  afterAll(async () => {
    await server?.close();
    await rm(workDir, { recursive: true, force: true });
  });

  /** Render a script that always fails at a known point, and return the error it raised. */
  const renderFailing = async (
    name: string,
  ): Promise<{
    error: VideoRenderError;
    videoDir: string;
  }> => {
    const runDir = join(workDir, name);
    const video = await createVideo({
      viewport: 'vertical',
      fps: 30,
      seed: 1,
      output: join(runDir, 'out.mp4'),
      outputDir: runDir,
      // A short action timeout keeps each failing case from spending the default 20 seconds
      // waiting for a selector that will never appear.
      timeouts: { action: 2500, navigation: 10_000 },
      recorder: { preset: 'ultrafast' },
    });

    let error: unknown;
    try {
      await video.scene('analysis', async () => {
        await video.open(server.url('/'));
        await video.pause(200);
        // This is the failure: a selector that does not exist.
        await video.click('#no-such-element');
      });
      await video.export();
    } catch (thrown) {
      error = thrown;
    } finally {
      await video.dispose();
    }

    return { error: error as VideoRenderError, videoDir: runDir };
  };

  it('raises a VideoRenderError, not a bare Playwright error', async () => {
    const { error } = await renderFailing('type');
    expect(error).toBeInstanceOf(VideoRenderError);
  });

  it('names the scene, action, selector, url and elapsed time', async () => {
    const { error } = await renderFailing('context');

    expect(error.context.scene).toBe('analysis');
    expect(error.context.action).toBe('click');
    expect(error.context.selector).toBe('#no-such-element');
    expect(error.context.url).toContain('127.0.0.1');
    expect(error.context.elapsedMs).toBeGreaterThan(0);
  });

  it('lists where the artefacts are', async () => {
    const { error } = await renderFailing('artefacts');

    // The report is what a user reads. If it does not point at the artefacts, they are useless.
    expect(Object.keys(error.artifacts).length).toBeGreaterThan(0);
    expect(error.report()).toMatch(/artefacts:/);
  });

  it('writes a screenshot, a trace, a console log and an error file', async () => {
    const { videoDir } = await renderFailing('files');
    const debugDir = await findRunDir(videoDir);

    const files = await readdir(debugDir);
    expect(files).toContain('screenshot.png');
    expect(files).toContain('trace.zip');
    expect(files).toContain('console.log');
    expect(files).toContain('error.json');
    expect(files).toContain('manifest.json');

    // The trace must be a real zip, not an empty file.
    const trace = await stat(join(debugDir as string, 'trace.zip'));
    expect(trace.size).toBeGreaterThan(500);

    const screenshot = await stat(join(debugDir as string, 'screenshot.png'));
    expect(screenshot.size).toBeGreaterThan(500);
  }, 180_000);

  it('writes a manifest that records the failure and where it happened', async () => {
    const { videoDir } = await renderFailing('manifest-file');
    const debugDir = await findRunDir(videoDir);
    const manifest = JSON.parse(await readFile(join(debugDir, 'manifest.json'), 'utf8')) as Record<
      string,
      any
    >;

    expect(manifest.status).toBe('failed');
    expect(manifest.failure.context.selector).toBe('#no-such-element');
    expect(manifest.failure.context.scene).toBe('analysis');
    // The scenes recorded before the failure survive, so you can see how far the run got.
    expect(Array.isArray(manifest.scenes)).toBe(true);
    expect(manifest.scenes[0].name).toBe('analysis');
  }, 180_000);

  it('serialises the error itself to JSON', async () => {
    const { videoDir } = await renderFailing('error-file');
    const debugDir = await findRunDir(videoDir);
    const error = JSON.parse(await readFile(join(debugDir, 'error.json'), 'utf8')) as Record<
      string,
      unknown
    >;

    expect(error.name).toBe('VideoRenderError');
    expect(error.context).toBeDefined();
  }, 180_000);

  it('leaves no video behind', async () => {
    const { videoDir } = await renderFailing('no-video');

    // The contract: a failed run must not leave something that looks finished.
    await expect(stat(join(videoDir, 'out.mp4'))).rejects.toThrow();
  }, 180_000);

  it('keeps each run’s artefacts separate', async () => {
    await renderFailing('run-a');
    await renderFailing('run-b');

    // Each run gets its own timestamped directory. Overwriting the previous failure destroys
    // the only copy of the bug you just spent an hour reproducing.
    const runsA = await readdir(join(workDir, 'run-a', 'debug'));
    const runsB = await readdir(join(workDir, 'run-b', 'debug'));

    expect(runsA).toHaveLength(1);
    expect(runsB).toHaveLength(1);
    expect(runsA[0]).not.toBe(runsB[0]);
  }, 240_000);
});

describe('success diagnostics', () => {
  let server: FixtureServer;
  let workDir: string;

  beforeAll(async () => {
    server = await createFixtureServer();
    workDir = await mkdtemp(join(tmpdir(), 'autovideo-success-'));
  });

  afterAll(async () => {
    await server?.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it('writes a manifest beside the video', async () => {
    const output = join(workDir, 'ok.mp4');
    const video = await createVideo({
      viewport: 'vertical',
      fps: 30,
      seed: 99,
      output,
      outputDir: workDir,
      recorder: { preset: 'ultrafast' },
    });

    try {
      await video.scene('demo', async () => {
        await video.open(server.url('/'));
        await video.pause(300);
      });
      await video.export();
    } finally {
      await video.dispose();
    }

    const manifest = JSON.parse(
      await readFile(`${output.replace(/\.mp4$/, '')}.manifest.json`, 'utf8'),
    ) as Record<string, any>;

    expect(manifest.status).toBe('success');
    expect(manifest.seed).toBe(99);
    expect(manifest.fps).toBe(30);
    expect(manifest.width).toBe(1080);
    expect(manifest.height).toBe(1920);
    expect(manifest.frameworkVersion).toBeTruthy();
    expect(manifest.scenes[0].name).toBe('demo');
  }, 180_000);

  it('writes no debug directory for a successful run', async () => {
    const runDir = join(workDir, 'clean');
    const video = await createVideo({
      viewport: 'vertical',
      fps: 30,
      output: join(runDir, 'clean.mp4'),
      outputDir: runDir,
      recorder: { preset: 'ultrafast' },
    });

    try {
      await video.open(server.url('/'));
      await video.pause(200);
      await video.export();
    } finally {
      await video.dispose();
    }

    // Diagnostics are buffered in memory and only written on failure. A successful render
    // should leave nothing behind to confuse a later reader.
    const entries = await readdir(runDir);
    expect(entries).not.toContain('debug');
  }, 180_000);
});

describe('VideoRenderError report', () => {
  it('lists every known fact and omits the unknown ones', () => {
    const error = new VideoRenderError(
      'Selector was not found within 5000ms.',
      {
        scene: 'chart-analysis',
        action: 'scrollTo',
        selector: '#technical-analysis',
        url: 'https://example.com/dashboard',
        elapsedMs: 17400,
      },
      { hint: 'Check the selector.', artifacts: { screenshot: './debug/screenshot.png' } },
    );

    const report = error.report();
    expect(report).toContain('chart-analysis');
    expect(report).toContain('scrollTo');
    expect(report).toContain('#technical-analysis');
    expect(report).toContain('https://example.com/dashboard');
    expect(report).toContain('17.40s');
    expect(report).toContain('Check the selector.');
    expect(report).toContain('./debug/screenshot.png');
  });

  it('leaves out fields it does not know rather than printing them empty', () => {
    const report = new VideoRenderError('boom').report();

    // A report padded with "scene: unknown" teaches the reader to skim past it.
    expect(report).toBe('boom');
  });

  it('formats durations for humans', () => {
    expect(formatDuration(400)).toBe('400ms');
    expect(formatDuration(1500)).toBe('1.50s');
    expect(formatDuration(90_000)).toBe('1m 30s');
  });
});

describe('BrowserLog', () => {
  it('records console output and page errors', async () => {
    const log = new BrowserLog();
    const handlers = new Map<string, (...args: unknown[]) => void>();

    const fakePage = {
      on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler),
    } as never;

    log.attach(fakePage);

    handlers.get('console')?.({ type: () => 'warning', text: () => 'deprecated api' });
    handlers.get('pageerror')?.(new Error('Uncaught TypeError'));

    const text = log.consoleLog();
    expect(text).toContain('deprecated api');
    // A page error is usually why a selector stopped matching, so it is logged explicitly.
    expect(text).toContain('pageerror');
  });

  it('records failed requests', () => {
    const log = new BrowserLog();
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const fakePage = {
      on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler),
    } as never;

    log.attach(fakePage);
    handlers.get('requestfailed')?.({
      method: () => 'GET',
      url: () => 'https://example.com/api',
      failure: () => ({ errorText: 'net::ERR_CONNECTION_REFUSED' }),
    });

    expect(log.networkLog()).toContain('ERR_CONNECTION_REFUSED');
  });

  it('says so when it truncates, rather than pretending to be complete', () => {
    const log = new BrowserLog();
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const fakePage = {
      on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler),
    } as never;

    log.attach(fakePage);

    const emit = handlers.get('console');
    for (let index = 0; index < BrowserLog.LIMIT + 10; index++) {
      emit?.({ type: () => 'log', text: () => `message ${index}` });
    }

    expect(log.consoleLog()).toContain('truncated');
  });
});
