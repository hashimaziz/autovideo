import { defineConfig } from 'vitest/config';

/**
 * Unit tests only.
 *
 * These must stay fast and hermetic: no Chromium, no ffmpeg, no network. Every guarantee the
 * framework makes about determinism — seeded randomness, easing curves, logical timing, config
 * validation — is provable here without booting a browser, so it is proved here.
 *
 * Anything that needs a browser lives in `tests/integration/` and runs under
 * `vitest.integration.config.ts` via `npm run test:integration`.
 */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The public entry point is covered indirectly by the integration suite;
      // excluding it keeps the unit report honest rather than flattering.
      exclude: ['src/index.ts'],
      reporter: ['text', 'html'],
    },
  },
});
