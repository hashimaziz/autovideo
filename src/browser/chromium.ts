/**
 * Finding out whether Chromium is actually usable — before a script runs.
 *
 * Playwright 1.63 no longer downloads browsers on install, which is the right default: silently
 * pulling ~150MB during someone's `npm install` in CI is how a package gets disliked. The cost is
 * that a missing browser is discovered at launch, by which point the user has written a script,
 * installed Chromium-free dependencies, and is waiting on a render that was never going to happen.
 *
 * So the check is made explicit and early. `createVideo()` runs it before launching anything, and
 * the `doctor` command reports the same result. One implementation, so the two cannot disagree —
 * the same lesson as the two scroll-container rules in `browser/scrolling.ts`.
 *
 * ### Why this cannot simply ask Playwright
 *
 * `chromium.executablePath()` *returns a path whether or not the browser exists*. It computes where
 * the browser would be installed and stops there; it does not check. So the path has to be
 * stat'ed, and it also has to be checked for the execute bit: a file that is present but not
 * executable is as useless as one that is absent, and produces a far more confusing launch error.
 */

import { access, constants } from 'node:fs/promises';

import { chromium } from 'playwright';

import type { VideoConfig } from '../config/config.js';

/** The outcome of looking for a browser. */
export interface ChromiumCheck {
  /** True when a browser is present and executable. */
  ok: boolean;
  /** The path that was found or expected. */
  path: string;
  /**
   * Where that path came from.
   *
   * Worth distinguishing in a message: "no browser is installed" and "you pointed at a path that
   * isn't there" call for completely different fixes, and reporting both as "not installed" sends
   * someone to download a second browser they never needed.
   */
  source: 'configured' | 'playwright';
  /** Why the check failed, when it did. */
  reason?: 'missing' | 'not-executable' | 'not-configured';
}

/**
 * Resolve which browser would be used, and whether it can actually be run.
 *
 * `config.browser.executablePath` takes precedence, matching what `launchBrowser` does — the point
 * is to describe the browser that will *actually* launch, not some ideal one.
 */
export async function checkChromium(config: VideoConfig): Promise<ChromiumCheck> {
  const configured = config.browser.executablePath;

  if (configured !== undefined) {
    // A configured path that does not exist is a configuration mistake, not a missing install.
    // Throwing rather than falling back keeps it visible: silently launching a different browser
    // than the one someone explicitly asked for would be worse than the error.
    try {
      await access(configured, constants.X_OK);
      return { ok: true, path: configured, source: 'configured' };
    } catch {
      const exists = await pathExists(configured);
      return {
        ok: false,
        path: configured,
        source: 'configured',
        reason: exists ? 'not-executable' : 'not-configured',
      };
    }
  }

  // executablePath() returns the expected location whether or not anything is there, so the result
  // has to be stat'ed. It can also throw when no browser has ever been installed.
  let expected: string;
  try {
    expected = chromium.executablePath();
  } catch {
    return { ok: false, path: '', source: 'playwright', reason: 'missing' };
  }

  try {
    await access(expected, constants.X_OK);
    return { ok: true, path: expected, source: 'playwright' };
  } catch {
    return {
      ok: false,
      path: expected,
      source: 'playwright',
      reason: (await pathExists(expected)) ? 'not-executable' : 'missing',
    };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * What to tell someone whose browser is missing.
 *
 * Kept next to the check so the advice cannot drift from the diagnosis, and worded to name the
 * alternative: most people hit this and assume the only fix is a download.
 */
export function chromiumFix(check: ChromiumCheck): string {
  if (check.source === 'configured') {
    return check.reason === 'not-executable'
      ? `browser.executablePath points at ${check.path}, which is not executable.`
      : `browser.executablePath points at ${check.path}, which does not exist. Check the path, or remove it to use Playwright's own browser.`;
  }

  return (
    'Run `npx playwright install chromium`. To use a browser you already have instead, set ' +
    'browser.executablePath — for example Chrome on macOS at ' +
    "'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'."
  );
}
