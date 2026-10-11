import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveConfig } from '../../src/config/config.js';
import { checkChromium, chromiumFix } from '../../src/browser/chromium.js';
import { VideoBrowserError } from '../../src/runtime/errors.js';
import { launchBrowser } from '../../src/browser/session.js';

/**
 * Finding a usable Chromium before a script runs.
 *
 * Playwright does not download a browser on install, so "no browser" is an ordinary state rather
 * than a broken install. These tests pin down that it is detected up front, and — the part that is
 * easy to get wrong — that the two ways of not having a browser are reported differently. Telling
 * someone with a bad `browser.executablePath` to go and download a browser is actively misleading.
 */
describe('checkChromium', () => {
  const dirs: string[] = [];

  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'autovideo-chromium-'));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    dirs.length = 0;
  });

  const config = (executablePath?: string) =>
    resolveConfig({
      viewport: { width: 1080, height: 1920 },
      ...(executablePath === undefined ? {} : { browser: { executablePath } }),
    });

  it('finds the installed browser when Playwright has one', async () => {
    const result = await checkChromium(config());

    // This machine has Chromium installed, so this should pass. If it ever fails in CI the fix is
    // to install the browser in CI, not to weaken the assertion.
    expect(result.ok).toBe(true);
    expect(result.source).toBe('playwright');
    expect(result.path).not.toBe('');
  });

  it('accepts an executable file given as executablePath', async () => {
    const file = join(scratch(), 'browser');
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, 0o755);

    const result = await checkChromium(config(file));

    expect(result).toMatchObject({ ok: true, source: 'configured', path: file });
  });

  it('reports a configured path that does not exist as a configuration error', async () => {
    // Deliberately not "not installed": the browser may well be installed, and telling this user
    // to download one would be sending them the wrong way.
    const result = await checkChromium(config('/nope/not/here'));

    expect(result).toMatchObject({ ok: false, source: 'configured', reason: 'not-configured' });
    expect(chromiumFix(result)).toContain('/nope/not/here');
    expect(chromiumFix(result)).toContain('browser.executablePath');
  });

  it('distinguishes a file that exists but is not executable', async () => {
    const file = join(scratch(), 'browser');
    writeFileSync(file, '');
    chmodSync(file, 0o644);

    const result = await checkChromium(config(file));

    expect(result).toMatchObject({ ok: false, reason: 'not-executable' });
    expect(chromiumFix(result)).toContain('not executable');
  });

  it('names the existing browser in its fix message, not just the download command', async () => {
    // The alternative has to be offered, because most people would rather not install a second
    // browser on a machine that already has one.
    const result: Awaited<ReturnType<typeof checkChromium>> = {
      ok: false,
      path: '/somewhere/chromium',
      source: 'playwright',
      reason: 'missing',
    };

    const fix = chromiumFix(result);

    expect(fix).toContain('npx playwright install chromium');
    expect(fix).toContain('browser.executablePath');
  });
});

describe('launching without a browser', () => {
  it('fails immediately, with a hint, before any page is opened', async () => {
    // The behaviour that motivated the check: previously this only surfaced as a failed launch,
    // after the script had been written and the render started.
    const config = resolveConfig({
      viewport: { width: 1080, height: 1920 },
      browser: { executablePath: '/definitely/not/a/browser' },
    });

    const error = await launchBrowser(config).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(VideoBrowserError);
    expect((error as VideoBrowserError).message).toMatch(/executablePath/);
    expect((error as VideoBrowserError).hint).toMatch(/does not exist/);
  }, 60_000);
});
