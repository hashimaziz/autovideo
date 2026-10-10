/**
 * autovideo — deterministic browser-to-video framework.
 *
 * The public surface is intentionally small. The target experience is:
 *
 * ```ts
 * import { createVideo } from 'autovideo';
 *
 * const video = await createVideo({ viewport: 'vertical', fps: 60, seed: 42069 });
 * await video.open('https://yourapp.com');
 * await video.type('#search', 'AAPL', { behavior: 'natural' });
 * await video.scrollTo('#chart', { behavior: 'natural' });
 * await video.export('./demo.mp4');
 * ```
 *
 * Everything exported here is public API and carries a compatibility promise. Anything not
 * exported is an implementation detail and may change without notice — the internal layering
 * (runtime / browser / motion / recorder) is a design, not a contract.
 */

export { VERSION } from './version.js';
export { ClockStalledError, LogicalClock } from './runtime/clock.js';
export { Timeline } from './runtime/timeline.js';
export type { ActionRecord, SceneRecord } from './runtime/timeline.js';
export type { WaitRecord } from './runtime/clock.js';
export { resolveConfig, VIEWPORT_PRESETS, VIEWPORT_PRESET_NAMES } from './config/config.js';
export type {
  BrowserConfig,
  CursorConfig,
  CursorMode,
  DebugConfig,
  RecorderBackend,
  RecorderConfig,
  ResolvedViewport,
  Size,
  VideoConfig,
  VideoConfigInput,
  ViewportInput,
  ViewportPreset,
} from './config/config.js';
