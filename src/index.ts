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
