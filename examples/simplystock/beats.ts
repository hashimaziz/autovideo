/**
 * Shared beats — the vocabulary the video scripts are written in.
 *
 * This replaces the previous implementation's `templates/shared.ts`, which was seven helpers over a
 * raw Playwright `Page`. Each one here is the same beat expressed through the framework, and the
 * differences are the point:
 *
 * - `centerOn` was a hand-rolled scroll that measured the element and eased the window. It is now
 *   `scrollTo`, which does the same thing *and* verifies the element actually landed, instead of
 *   reporting success for a mis-derived target.
 * - `requireVisible` was a wait with a hand-built error. It is now `waitForSelector`, which fails
 *   with the scene and selector already attached.
 * - The originals read element text purely to put it in the manifest. The framework has no
 *   read-text API, so marks here carry a note and a selector instead. That is a genuine reduction
 *   in manifest detail — see "Known differences" in the README.
 *
 * Everything app-shaped still lives in `selectors.ts`. Nothing here knows what a price summary is.
 */

import type { Video } from '@saltyhasbrown/autovideo';

import {
  INDICATOR,
  TID,
  byTestId,
  chartOption,
  guideEntry as guideEntryFor,
  indexToggle,
  signalCard,
} from './selectors.js';

/** Named dwell times, in the spirit of the original's `settle()` levels. */
export const DWELL = {
  /** A beat's worth of reading time. */
  short: 900,
  /** Enough to read a number and a sentence. */
  normal: 1300,
  /** A full beat — a verdict, or a closing frame. */
  long: 2200,
} as const;

/**
 * Put the dashboard in a presentable starting state.
 *
 * The market-indices panel sits above the analysis, so without waiting for it the opening frames
 * catch it mid-spinner reading "Loading market data…", which looks broken in a promo.
 *
 * Tolerant on purpose: a script that does not feature the indices should not fail because they did
 * not load.
 */
export async function prepareDashboard(video: Video): Promise<void> {
  await video
    .waitForSelector(byTestId(TID.marketIndices), { state: 'visible', timeoutMs: 15_000 })
    .catch(() => undefined);
  // Page is already at top after load; no scroll needed
}

/**
 * Enter the ticker and wait for the analysis to land.
 *
 * The field arrives pre-filled with the dashboard's default ticker, and `type` appends to whatever
 * is already there — so typing into it unchecked produces `AAPL` + `AAPL`, which the endpoint
 * rejects. Clearing first is both correct and the honest gesture.
 *
 * `ControlOrMeta` rather than `Meta`, so these scripts do not become macOS-only.
 */
export async function analyseTicker(
  video: Video,
  ticker: string,
  period: string,
  timeframeSelector: string,
): Promise<void> {
  await video.cursor.clickSelector(timeframeSelector);
  await video.pause(DWELL.short);

  await video.cursor.clickSelector(byTestId(TID.tickerInput));
  await video.press(byTestId(TID.tickerInput), 'ControlOrMeta+A');
  await video.press(byTestId(TID.tickerInput), 'Backspace');
  await video.type(byTestId(TID.tickerInput), ticker, { behavior: 'natural', speed: 110 });

  await video.cursor.clickSelector(byTestId(TID.analyzeButton));

  // Waiting on application state, never on a sleep. The API call's duration is the app's, and the
  // video shows whatever that turned out to be.
  await video.waitForSelector(byTestId(TID.analysisResults), {
    state: 'visible',
    timeoutMs: 30_000,
  });
  await video.pause(DWELL.normal);
}

/**
 * Show a chart overlay as a beat.
 *
 * Deliberately silent about the checkbox itself: the point is the overlay appearing on the chart,
 * so the camera goes to the chart afterwards rather than filming three no-op checkbox visits.
 */
export async function enableChartOption(
  video: Video,
  option: 'include-chart' | 'bands' | 'ma' | 'support-resistance',
): Promise<void> {
  await video.waitForSelector(chartOption(option), { state: 'visible' });
  await video.cursor.clickSelector(chartOption(option));
}

/** Centre a section and mark it. */
export async function presentSection(video: Video, testId: string, note: string): Promise<void> {
  const selector = byTestId(testId);
  await video.waitForSelector(selector, { state: 'visible' });
  await video.scrollTo(selector, { behavior: 'natural' });
  video.mark(note, { selector: testId });
}

/** Centre a specific indicator signal card and mark it. */
export async function presentIndicator(
  video: Video,
  indicator: keyof typeof INDICATOR,
  note: string,
): Promise<void> {
  const selector = signalCard(INDICATOR[indicator]);
  await video.waitForSelector(selector, { state: 'visible' });
  await video.scrollTo(selector, { behavior: 'natural' });
  video.mark(note, { selector: TID.signalCard });
}

/** Centre a labelled reading from the price summary, e.g. support or ATR. */
export async function presentPriceMetric(
  video: Video,
  metric: 'current-price' | 'support-value' | 'resistance-value' | 'atr-value',
  note: string,
): Promise<void> {
  const selector = byTestId(metric);
  await video.waitForSelector(selector, { state: 'visible' });
  await video.scrollTo(selector, { behavior: 'natural' });
  video.mark(note, { selector: metric });
}

/** Open the indicator guide and centre a specific entry inside it. */
export async function openGuideEntry(video: Video, entryName: string, note: string): Promise<void> {
  await video.cursor.clickSelector(byTestId(TID.openGuide));
  await video.waitForSelector(byTestId(TID.cheatsheetModal), { state: 'visible' });

  const entry = guideEntryFor(entryName);
  await video.waitForSelector(entry, { state: 'visible' });
  // The modal has its own scroll container. Page-level scrolling cannot reach inside it, so the
  // entry is scrolled to with its own container-aware path — the previous implementation needed a
  // bespoke `centerInScrollContainer` for exactly this, and it is still the one case `scrollTo`
  // cannot express, because the framework scrolls the document.
  await video.scrollTo(entry, { behavior: 'natural' });
  video.mark(note, { selector: TID.guideEntry });
}

/** Close whatever modal is open. */
export async function closeModal(video: Video): Promise<void> {
  await video.waitForSelector(byTestId(TID.modalClose), { state: 'visible' });
  await video.cursor.clickSelector(byTestId(TID.modalClose));
  await video
    .waitForSelector(byTestId(TID.cheatsheetModal), { state: 'hidden', timeoutMs: 5_000 })
    .catch(() => undefined);
}

/** Show the playbook section and dwell on it. */
export async function presentStrategySection(video: Video, note: string): Promise<void> {
  await presentSection(video, TID.strategySection, note);
}

/**
 * Whether any playbook is currently active.
 *
 * Cannot be determined: the active badge is nested inside a card, and "does any card contain this
 * thing" is a DOM query the public API does not expose. The previous implementation ran exactly
 * that filter. Here the section is simply shown, and the note says the active setup is whichever is
 * badged — so the video never claims something it cannot verify.
 */
export async function presentPlaybooks(video: Video): Promise<void> {
  await presentStrategySection(
    video,
    'Named playbooks checked against this stock — the active one is badged',
  );
}

/** Isolate a market index so a single line can be followed on a phone. */
export async function isolateIndex(video: Video, index: 'sp500' | 'nasdaq' | 'dow'): Promise<void> {
  for (const other of ['nasdaq', 'dow'] as const) {
    if (other === index) continue;
    await video.click(indexToggle(other));
  }
  // The last click leaves focus on a label, which the app renders as a ring. Blur it so the
  // comparison frame is clean.
  await video.press(undefined, 'Escape');
  await video.cursor.hide();
}
