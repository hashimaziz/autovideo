#!/usr/bin/env node
/**
 * Verify that every selector this port uses actually exists in the SimplyStock app.
 *
 * The port cannot be rendered in CI — it needs a running app, market data and an authenticated
 * session. What *can* be verified is the part most likely to rot: the selector strings. A
 * `data-testid` renamed in the app should fail here rather than three scenes deep into a
 * fifteen-minute render.
 *
 * Run:
 *   node examples/simplystock/verify-selectors.mjs
 *   SIMPLYSTOCK_WEB=/path/to/web node examples/simplystock/verify-selectors.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Locate the app's source tree. Defaults to ../web, a sibling of this directory. */
const webRoot = resolve(
  process.env.SIMPLYSTOCK_WEB ?? join(here, '..', '..', 'web'),
);

if (!exists(webRoot)) {
  console.error(
    `Could not find the web app at ${webRoot}.\n` +
      `Point SIMPLYSTOCK_WEB at it:\n` +
      `  SIMPLYSTOCK_WEB=/path/to/SimplyStock/web node examples/simplystock/verify-selectors.mjs`,
  );
  process.exit(2);
}

function exists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Every `.tsx` file in the app, as one string. Selector checks are textual by nature. */
function readAllTsx(root) {
  const sources = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        // Skip build output and dependency trees.
        if (entry === 'node_modules' || entry === '.next') continue;
        walk(full);
      } else if (entry.endsWith('.tsx')) {
        sources.push(readFileSync(full, 'utf8'));
      }
    }
  };
  walk(root);
  return sources.join('\n');
}

const source = readAllTsx(webRoot);

/**
 * Selectors this port depends on, and what each must appear as in the app.
 *
 * Listed here rather than imported from `selectors.ts` so the check stays readable: this is a
 * specification of the app's contract with the video, not a re-execution of the script.
 */
const required = [
  // [description, string that must appear in the app source]
  ['app shell', 'data-testid="app-shell"'],
  ['ticker input', 'data-testid="ticker-input"'],
  ['analyze button', 'data-testid="analyze-button"'],
  ['analysis results', 'data-testid="analysis-results"'],
  ['price summary', 'data-testid="price-summary"'],
  ['current price', 'data-testid="current-price"'],
  ['support value', 'data-testid="support-value"'],
  ['resistance value', 'data-testid="resistance-value"'],
  ['ATR value', 'data-testid="atr-value"'],
  ['overall signal', 'data-testid="overall-signal"'],
  ['signal card', 'data-testid="signal-card"'],
  ['signal grid', 'data-testid="signal-grid"'],
  ['market indices', 'data-testid="market-indices"'],
  ['strategy section', 'data-testid="strategy-section"'],
  ['timeframe button', 'data-testid="timeframe-button"'],
  ['chart option: bands', 'data-testid="chart-option-bands"'],
  ['chart option: ma', 'data-testid="chart-option-ma"'],
  ['chart option: support-resistance', 'data-testid="chart-option-support-resistance"'],
  ['timeframe period attribute', 'data-period='],
  ['signal indicator attribute', 'data-indicator='],
  ['portfolio section (redaction)', 'data-testid="portfolio-section"'],
  ['watchlist section (redaction)', 'data-testid="watchlist-section"'],
];

const missing = required.filter(([, needle]) => !source.includes(needle));

console.log(`Checked ${required.length} selectors against ${webRoot}\n`);

for (const [label, needle] of required) {
  const found = source.includes(needle);
  console.log(`  ${found ? '✓' : '✗'} ${label.padEnd(36)} ${needle}`);
}

if (missing.length > 0) {
  console.error(
    `\n${missing.length} selector(s) not found. The app and this port have drifted apart.\n` +
      `Re-check examples/simplystock/selectors.ts against the app.`,
  );
  process.exit(1);
}

console.log('\nEvery selector this port uses exists in the app.');
