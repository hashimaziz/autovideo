/**
 * Diagnostics.
 *
 * When a render fails, the question is always the same: what did the page look like, and what
 * did the browser say? Everything here exists to answer it without re-running anything.
 *
 * Every capture is individually guarded. A diagnostics step that throws must never replace the
 * original failure with its own — that is how "the render failed" becomes "the render failed for
 * an unrelated reason", and the original is lost forever.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Page } from 'playwright';

import type { DebugConfig } from '../config/config.js';
import type { ArtifactList } from './render-error.js';

/** Files written into the debug directory. */
export interface DebugArtifacts extends ArtifactList {
  /** The directory everything was written to. */
  dir: string;
}

/** Buffered console messages, for the `console.log` artefact. */
export interface ConsoleEntry {
  at: number;
  type: string;
  text: string;
}

/** Buffered network activity, for the `network.log` artefact. */
export interface NetworkEntry {
  at: number;
  method: string;
  url: string;
  status: number | undefined;
  failed: boolean;
  error: string | undefined;
}

/**
 * Records browser console output and network activity for the life of a run.
 *
 * Buffered in memory rather than streamed to disk, because nothing is written unless the run
 * actually fails. A successful render should leave no debug output at all.
 */
export class BrowserLog {
  readonly #console: ConsoleEntry[] = [];

  readonly #network: NetworkEntry[] = [];

  readonly #startedAt = Date.now();

  /**
   * Cap on buffered entries.
   *
   * A page doing analytics can emit thousands of requests, and an unbounded buffer on a run that
   * then fails is a memory problem. Truncation is recorded rather than silent, so the log says
   * it is incomplete instead of pretending otherwise.
   */
  static readonly LIMIT = 500;

  #consoleTruncated = false;
  #networkTruncated = false;

  attach(page: Page): void {
    page.on('console', (message) => {
      if (this.#console.length >= BrowserLog.LIMIT) {
        this.#consoleTruncated = true;
        return;
      }
      this.#console.push({
        at: Date.now() - this.#startedAt,
        type: message.type(),
        text: message.text(),
      });
    });

    page.on('pageerror', (error) => {
      if (this.#console.length >= BrowserLog.LIMIT) {
        this.#consoleTruncated = true;
        return;
      }
      // A page error is the single most useful line in the whole diagnostic set when a
      // selector stops matching because the app crashed.
      this.#console.push({
        at: Date.now() - this.#startedAt,
        type: 'pageerror',
        text: error.message,
      });
    });

    page.on('requestfailed', (request) => {
      if (this.#network.length >= BrowserLog.LIMIT) {
        this.#networkTruncated = true;
        return;
      }
      this.#network.push({
        at: Date.now() - this.#startedAt,
        method: request.method(),
        url: request.url(),
        status: undefined,
        failed: true,
        error: request.failure()?.errorText ?? 'unknown',
      });
    });

    page.on('response', (response) => {
      if (this.#network.length >= BrowserLog.LIMIT) {
        this.#networkTruncated = true;
        return;
      }
      this.#network.push({
        at: Date.now() - this.#startedAt,
        method: response.request().method(),
        url: response.url(),
        status: response.status(),
        failed: response.status() >= 400,
        error: undefined,
      });
    });
  }

  /** Render the console buffer as text. */
  consoleLog(): string {
    const header = this.#consoleTruncated ? `# truncated at ${BrowserLog.LIMIT} entries\n` : '';
    return (
      header +
      this.#console.map((entry) => `[${entry.at}ms] ${entry.type}: ${entry.text}`).join('\n')
    );
  }

  /** Render the network buffer as text. */
  networkLog(): string {
    const header = this.#networkTruncated ? `# truncated at ${BrowserLog.LIMIT} entries\n` : '';
    return (
      header +
      this.#network
        .map((entry) =>
          [
            `[${entry.at}ms]`,
            entry.method,
            entry.url,
            entry.status !== undefined ? String(entry.status) : 'failed',
            entry.failed ? `(${entry.error ?? 'failed'})` : '',
          ]
            .filter(Boolean)
            .join(' '),
        )
        .join('\n')
    );
  }

  consoleEntries(): readonly ConsoleEntry[] {
    return this.#console;
  }

  networkEntries(): readonly NetworkEntry[] {
    return this.#network;
  }
}

export interface CaptureDiagnosticsInput {
  page: Page | undefined;
  config: DebugConfig;
  /** Absolute path of the debug directory for this run. */
  dir: string;
  log: BrowserLog;
  /** Already-known artefact paths, e.g. a trace written before the failure. */
  existing?: ArtifactList;
  /** Written as `error.json`. */
  error: unknown;
  /** Written as `manifest.json`. */
  manifest: unknown;
}

/**
 * Write the diagnostic set.
 *
 * Returns the paths written, so the error can list them and the manifest can record them.
 * Never throws: a failure here is reported as a missing artefact, not as a new error.
 */
export async function captureDiagnostics(input: CaptureDiagnosticsInput): Promise<DebugArtifacts> {
  const { page, config, dir, log, error, manifest, existing = {} } = input;

  const artifacts: DebugArtifacts = { ...existing, dir };

  const safe = async (name: string, body: () => Promise<string | undefined>): Promise<void> => {
    try {
      await body();
    } catch {
      // Deliberately swallowed. A diagnostics step that fails must not mask the original error,
      // which is the one thing the user actually needs to see.
    }
    void name;
  };

  await mkdir(dir, { recursive: true });

  await safe('manifest', async () => {
    const path = join(dir, 'manifest.json');
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    artifacts.manifest = path;
    return path;
  });

  await safe('error', async () => {
    const path = join(dir, 'error.json');
    const serialisable =
      typeof error === 'object' && error !== null && 'toJSON' in error
        ? JSON.stringify((error as { toJSON(): unknown }).toJSON(), null, 2)
        : JSON.stringify({ message: String(error) }, null, 2);
    await writeFile(path, `${serialisable}\n`, 'utf8');
    artifacts.error = path;
    return path;
  });

  if (!page) return artifacts;

  if (config.screenshot) {
    await safe('screenshot', async () => {
      const path = join(dir, 'screenshot.png');
      // Viewport-only: a full-page capture of a long dashboard can be tens of thousands of pixels
      // tall, and what failed is what was on screen.
      await page.screenshot({ path, fullPage: false, animations: 'disabled' });
      artifacts.screenshot = path;
      return path;
    });
  }

  if (config.console) {
    await safe('console', async () => {
      const path = join(dir, 'console.log');
      await writeFile(path, `${log.consoleLog()}\n`, 'utf8');
      artifacts.console = path;
      return path;
    });
  }

  if (config.network) {
    await safe('network', async () => {
      const path = join(dir, 'network.log');
      await writeFile(path, `${log.networkLog()}\n`, 'utf8');
      artifacts.network = path;
      return path;
    });
  }

  return artifacts;
}
