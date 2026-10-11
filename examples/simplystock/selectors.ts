/**
 * SimplyStock selectors.
 *
 * **Every piece of app-specific knowledge in the whole port lives in this file.**
 *
 * That is the point. The framework has no idea what SimplyStock is, what a "price summary" is, or
 * what `data-testid` means — it only knows `click`, `scrollTo` and `waitForSelector`. Everything
 * SimplyStock-shaped is here, and nothing here imports anything from `autovideo`.
 *
 * Porting to another application means editing this file and nothing else.
 */

/** `[data-testid="…"]` for an app test id. */
export const byTestId = (testId: string): string => `[data-testid="${testId}"]`;

/** Static test ids used by the demo. Mirrors the app's own `data-testid` attributes. */
export const TID = {
  // shell
  appShell: 'app-shell',
  dashboardMain: 'dashboard-main',
  dashboardError: 'dashboard-error',

  // ticker entry
  tickerInput: 'ticker-input',
  analyzeButton: 'analyze-button',
  analysisLoading: 'analysis-loading',
  analysisResults: 'analysis-results',

  // timeframes
  timeframeButton: 'timeframe-button',

  // price summary
  priceSummary: 'price-summary',
  currentPrice: 'current-price',
  supportValue: 'support-value',
  resistanceValue: 'resistance-value',
  atrValue: 'atr-value',
  overallSignal: 'overall-signal',

  // signals
  signalCard: 'signal-card',
  signalGrid: 'signal-grid',

  // chart
  stockChart: 'stock-chart',
  stockChartSurface: 'stock-chart-surface',
  stockChartEmpty: 'stock-chart-empty',
  chartPlot: 'chart-plot',
  drawTrendline: 'draw-trendline',
  clearTrendlines: 'clear-trendlines',
  chartDrawHint: 'chart-draw-hint',

  // market indices
  marketIndices: 'market-indices',
  marketIndicesChart: 'market-indices-chart',
  marketIndicesLoading: 'market-indices-loading',
  marketIndicesError: 'market-indices-error',

  // playbooks
  strategySection: 'strategy-section',
  strategyGrid: 'strategy-grid',
  strategyCard: 'strategy-card',
  strategyActiveBadge: 'strategy-active-badge',

  // indicator guide modal
  openGuide: 'open-guide',
  cheatsheetModal: 'cheatsheet-modal',
  guideEntry: 'guide-entry',
  modalClose: 'modal-close',

  // misc
  insufficientHistoryWarning: 'insufficient-history-warning',
} as const;

/** A market-index toggle checkbox, e.g. `indices-toggle-spx` → `indices-toggle-sp500`. */
export const indexToggle = (index: 'sp500' | 'nasdaq' | 'dow'): string =>
  `[data-testid="indices-toggle-${index}"]`;

/** A playbook card is addressed by the strategy id the app gives it. */
export const strategyCard = (strategyId: string): string =>
  `[data-testid="${TID.strategyCard}"][data-strategy-id="${strategyId}"]`;

/** The active-setup badge inside a playbook card. */
export const strategyActiveBadge = `[data-testid="${TID.strategyActiveBadge}"]`;

/** A guide entry is addressed by the indicator name it documents. */
export const guideEntry = (indicatorName: string): string =>
  `[data-testid="${TID.guideEntry}"][data-indicator="${indicatorName}"]`;

/** Playbook card ids the app renders, for the ones worth naming in a script. */
export const STRATEGY_ID = {
  pullbackToSupport: 'pullback_to_support',
  breakoutToHigh: 'breakout_to_high',
} as const;

/** A timeframe button carries its period in a sibling attribute, not in the test id. */
export const timeframe = (period: string): string =>
  `[data-testid="${TID.timeframeButton}"][data-period="${period}"]`;

/**
 * A signal card is addressed by its human-readable indicator name.
 *
 * The app renders these strings — "RSI", "MA Crossover", "ADX Trend Strength" — so they are
 * spelled the way the app spells them rather than as an enum the framework would have to know.
 */
export const signalCard = (indicator: string): string =>
  `[data-testid="${TID.signalCard}"][data-indicator="${indicator}"]`;

/** Indicator names, exactly as the app renders them. */
export const INDICATOR = {
  bollinger: 'Bollinger Bands',
  ma: 'MA Crossover',
  rsi: 'RSI',
  macd: 'MACD',
  volume: 'Volume Spike',
  stochastic: 'Stochastic',
  adx: 'ADX Trend Strength',
  obv: 'OBV Volume Trend',
} as const;

/** Chart overlay toggles, presentational only. */
export const chartOption = (option: string): string => `[data-testid="chart-option-${option}"]`;

/** Routes. */
export const PATH = {
  dashboard: '/dashboard',
  landing: '/',
} as const;
