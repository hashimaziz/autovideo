/**
 * `autovideo doctor` — check that a render could actually succeed.
 *
 * Runs every precondition before a render would, so a failure surfaces as a sentence rather
 * than as a stack trace from whichever layer happened to need the missing piece first.
 *
 * Each check is independent: one failure does not stop the others, because "ffmpeg missing" and
 * "the app is not running" are two separate problems and reporting only the first sends the
 * user round the loop again.
 */

import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';

import { resolveConfig, VIEWPORT_PRESET_NAMES, type VideoConfigInput } from '../config/config.js';
import { VERSION } from '../version.js';
import { resolveFfmpegBinary } from '../recorder/encoder.js';
import { checkChromium, chromiumFix } from '../browser/chromium.js';
import { VideoError } from '../runtime/errors.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

/** One precondition and what it found. */
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  /** What to do about it, when something needs doing. */
  fix?: string;
}

export interface DoctorOptions {
  config?: VideoConfigInput;
  /** Check that this URL answers. */
  url?: string | undefined;
}

/**
 * Run every check.
 *
 * @returns the checks in the order they ran, and whether any of them failed.
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<{
  checks: Check[];
  ok: boolean;
}> {
  const checks: Check[] = [];
  const add = (check: Check): void => {
    checks.push(check);
  };

  // --- Node ---
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  add(
    major >= 20
      ? { name: 'Node.js', status: 'ok', detail: `v${process.versions.node}` }
      : {
          name: 'Node.js',
          status: 'fail',
          detail: `v${process.versions.node}`,
          fix: 'Node 20.11 or newer is required.',
        },
  );

  // --- Configuration ---
  let config;
  try {
    config = resolveConfig(options.config);
    add({
      name: 'Configuration',
      status: 'ok',
      detail: `${config.viewport.output.width}x${config.viewport.output.height} at ${config.fps}fps, seed ${config.seed}`,
    });
  } catch (error) {
    add({
      name: 'Configuration',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
      ...(error instanceof VideoError && error.hint ? { fix: error.hint } : {}),
    });
    // Every later check depends on a valid config, so stop rather than report noise.
    return { checks, ok: false };
  }

  // --- ffmpeg ---
  const ffmpeg = resolveFfmpegBinary(config.recorder.ffmpegPath);
  add(
    ffmpeg
      ? { name: 'ffmpeg', status: 'ok', detail: ffmpeg }
      : {
          name: 'ffmpeg',
          status: 'fail',
          detail: 'not found',
          fix: 'Run `npm install`, or set AUTOVIDEO_FFMPEG_PATH to your own build.',
        },
  );

  // --- Chromium ---
  // The same probe launchBrowser uses, so `doctor` cannot report a browser as fine that a render
  // would then refuse — or the reverse, which is the more annoying of the two.
  const chromiumCheck = await checkChromium(config);
  add(
    chromiumCheck.ok
      ? {
          name: 'Chromium',
          status: 'ok',
          detail:
            chromiumCheck.source === 'configured'
              ? `${chromiumCheck.path} (browser.executablePath)`
              : chromiumCheck.path,
        }
      : {
          name: 'Chromium',
          status: 'fail',
          detail:
            chromiumCheck.source === 'configured'
              ? `browser.executablePath unusable: ${chromiumCheck.path}`
              : 'not installed',
          fix: chromiumFix(chromiumCheck),
        },
  );

  // --- Output directory ---
  try {
    await mkdir(dirname(config.output), { recursive: true });
    const probe = `${config.output}.write-probe`;
    await writeFile(probe, '');
    const { unlink } = await import('node:fs/promises');
    await unlink(probe);
    add({ name: 'Output directory', status: 'ok', detail: dirname(config.output) });
  } catch (error) {
    add({
      name: 'Output directory',
      status: 'fail',
      detail: `${dirname(config.output)}: ${error instanceof Error ? error.message : String(error)}`,
      fix: 'Check the path and write permissions.',
    });
  }

  // --- Storage state, if configured ---
  if (config.browser.storageState) {
    try {
      await access(config.browser.storageState, constants.R_OK);
      add({ name: 'Storage state', status: 'ok', detail: config.browser.storageState });
    } catch {
      add({
        name: 'Storage state',
        status: 'fail',
        detail: `${config.browser.storageState} is not readable`,
        fix: 'Run `video login` or regenerate it.',
      });
    }
  }

  // --- Target application ---
  if (options.url) {
    try {
      const response = await fetch(options.url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status >= 500) {
        add({
          name: 'Target app',
          status: 'fail',
          detail: `${options.url} responded with HTTP ${response.status}`,
          fix: 'The app is running but erroring — check its terminal output.',
        });
      } else {
        add({
          name: 'Target app',
          status: response.status >= 400 ? 'warn' : 'ok',
          detail: `${options.url} → HTTP ${response.status}`,
          ...(response.status >= 400
            ? { fix: 'A redirect or auth challenge is fine; a 404 is usually a wrong path.' }
            : {}),
        });
      }
    } catch (error) {
      add({
        name: 'Target app',
        status: 'fail',
        detail: `${options.url}: ${error instanceof Error ? error.message : String(error)}`,
        fix: 'Start the application first.',
      });
    }
  }

  // --- Viewport presets, as a cheap sanity check on the resolver ---
  add({
    name: 'Viewport presets',
    status: 'ok',
    detail: VIEWPORT_PRESET_NAMES.join(', '),
  });

  add({ name: 'Framework', status: 'ok', detail: `autovideo ${VERSION}` });

  return { checks, ok: checks.every((check) => check.status !== 'fail') };
}

/** Render checks as aligned terminal text. */
export function formatChecks(checks: readonly Check[]): string {
  const width = Math.max(...checks.map((check) => check.name.length), 0);
  const marker: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗' };

  const lines = checks.map((check) => {
    const head = `  ${marker[check.status]} ${check.name.padEnd(width)}  ${check.detail}`;
    return check.fix ? `${head}\n      ${check.fix}` : head;
  });

  return lines.join('\n');
}
