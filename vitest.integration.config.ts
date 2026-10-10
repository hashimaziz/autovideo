import { defineConfig } from 'vitest/config';

/**
 * Integration tests: everything that needs a real Chromium or a real ffmpeg process.
 *
 * Kept in a separate project from the unit suite so `npm test` stays a sub-second feedback loop
 * while these take minutes. Each of these boots a browser, so they are also the suite most likely
 * to be flaky; every one is written to assert observable behaviour (frame counts, dimensions,
 * artifact presence) rather than internal calls.
 */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    // A browser launch plus frame capture is not fast, and the golden suite runs
    // the same script twice on purpose.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Browser instances are expensive and Chromium is happier serialised; the
    // plan's parallel-rendering goal is a Phase 1 P1 item, not a test-time concern.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text'],
    },
  },
});
