import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createVideo } from '../../src/video/index.js';
import { createFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

/**
 * Several renders in one process, at once.
 *
 * The backlog called this "a scheduling change rather than a design change", which turned out to
 * be optimistic. Each render did have its own scratch *file*, named from the pid and a timestamp —
 * but they shared a scratch *directory*, and cleanup removed that directory recursively. So a run
 * that finished first deleted the in-flight scratch file of a run that had not, and the second run
 * died at the final rename with a bare `ENOENT: ... render.mp4 -> out.mp4`, naming neither the
 * cause nor the other render involved.
 *
 * Rendering three videos in parallel is an ordinary thing to want — one script per product page,
 * or a matrix over viewports — and it used to fail whenever the runs finished close together.
 */
describe('concurrent renders', () => {
  let server: FixtureServer;
  let roots: string[] = [];

  beforeAll(async () => {
    server = await createFixtureServer();
  });

  afterAll(async () => {
    await server?.close();
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });

  /**
   * A fresh output directory per test.
   *
   * Runs within a test must share one directory — that is the scenario — but tests must not share
   * one with each other, or the file listings accumulate and the assertions become order-dependent.
   */
  async function freshDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'autovideo-concurrent-'));
    roots.push(dir);
    return dir;
  }

  /** Render one short video, tagged by name. Every run writes into the *same* output directory. */
  async function render(workDir: string, name: string) {
    const video = await createVideo({
      viewport: 'vertical',
      fps: 30,
      // The same seed throughout: identical work per run, so the finishes are close together and
      // the collision this guards against is actually provoked.
      seed: 42069,
      output: join(workDir, `${name}.mp4`),
      outputDir: workDir,
      recorder: { preset: 'ultrafast' },
    });

    try {
      await video.open(server.url('/'));
      await video.waitForSelector('#ticker');
      await video.cursor.moveTo('#ticker');
      await video.type('#ticker', 'AAPL', { behavior: 'natural', speed: 20 });
      await video.highlight('#results');
      await video.pause(400);
      return await video.export();
    } finally {
      await video.dispose();
    }
  }

  it('renders three videos into one directory without colliding', async () => {
    const workDir = await freshDir();
    const results = await Promise.all([
      render(workDir, 'a'),
      render(workDir, 'b'),
      render(workDir, 'c'),
    ]);

    for (const [index, result] of results.entries()) {
      expect((await stat(result.path)).size, `run ${index} produced a file`).toBeGreaterThan(0);
    }

    const produced = (await readdir(workDir)).filter((name) => name.endsWith('.mp4')).sort();
    expect(produced).toEqual(['a.mp4', 'b.mp4', 'c.mp4']);
  });

  it('produces the same result for each concurrent run', async () => {
    // Concurrency must not leak into the output. If a run's timing or frames were perturbed by
    // its neighbours, this is where it would show.
    const workDir = await freshDir();
    const results = await Promise.all([render(workDir, 'd'), render(workDir, 'e')]);

    expect(results[0].frames).toBe(results[1].frames);
    expect(results[0].durationMs).toBe(results[1].durationMs);
  });

  it('does not leave scratch files behind', async () => {
    const workDir = await freshDir();
    await render(workDir, 'f');

    const scratch = join(workDir, '.scratch');
    const remaining = await readdir(scratch).catch(() => []);

    // The root survives so the next run has somewhere to write; the per-run directories inside it
    // must not, or a long batch would fill the disk with dead intermediate video.
    expect(remaining).toEqual([]);
  });

  it('keeps each run’s manifest separate', async () => {
    const workDir = await freshDir();
    await Promise.all([render(workDir, 'g'), render(workDir, 'h')]);

    const manifests = (await readdir(workDir)).filter((name) => name.endsWith('.manifest.json'));

    expect(manifests.sort()).toEqual(['g.manifest.json', 'h.manifest.json']);
  });

  it('survives one concurrent run failing', async () => {
    // A failing run must clean up after itself without taking its neighbours' output with it.
    const workDir = await freshDir();
    const failing = await createVideo({
      viewport: 'vertical',
      fps: 30,
      seed: 42069,
      output: join(workDir, 'doomed.mp4'),
      outputDir: workDir,
      recorder: { preset: 'ultrafast' },
    });

    const results = await Promise.all([
      render(workDir, 'i'),
      failing
        .open(server.url('/'))
        .then(() => failing.click('#no-such-element'))
        .catch(() => 'failed as expected')
        .finally(() => failing.dispose()),
    ]);

    expect(results[1]).toBe('failed as expected');
    expect((await stat(join(workDir, 'i.mp4'))).size).toBeGreaterThan(0);
    expect((await readdir(workDir)).filter((n) => n.endsWith('.mp4')).sort()).toEqual(['i.mp4']);
  });
});
