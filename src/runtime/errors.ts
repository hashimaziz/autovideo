/**
 * Error types.
 *
 * The plan is explicit about this (§20): a failure must identify the scene, the action, the
 * selector, the URL, the elapsed time, and where the diagnostics are. A bare `TimeoutError` does
 * not identify any of those and is the single most common reason a video pipeline becomes
 * undebuggable.
 *
 * Every deliberate failure raised by this framework is a {@link VideoError}. Errors that come
 * *from* Playwright or ffmpeg are wrapped in one at the boundary, so callers never have to know
 * which layer failed.
 */

/** Base class for every failure the framework raises on purpose. */
export class VideoError extends Error {
  /**
   * A sentence telling the user what to do about it.
   *
   * Kept separate from the message because the two serve different readers: the message explains
   * what happened, the hint explains what to change. Callers that only log `message` still get a
   * useful explanation; the CLI prints both.
   */
  readonly hint: string | undefined;

  constructor(message: string, options: { hint?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.hint = options.hint;
  }

  /**
   * Plain object form, for `error.json` in the diagnostics folder.
   *
   * Deliberately open-ended: subclasses add their own context and artefact lists, and narrowing
   * this signature would make that an override error rather than an extension.
   */
  toJSON(): Record<string, unknown> {
    return { name: this.name, message: this.message, hint: this.hint };
  }
}

/** The browser could not be launched, or died while running. */
export class VideoBrowserError extends VideoError {}

/** An action could not be completed — element missing, not clickable, target off-screen. */
export class VideoActionError extends VideoError {}

/** ffmpeg is missing, could not start, or failed. */
export class VideoEncoderError extends VideoError {}

/** Frame capture failed, or the recording loop stopped unexpectedly. */
export class VideoRecorderError extends VideoError {}

/**
 * Wrap anything thrown into a {@link VideoError}, preserving an existing one.
 *
 * @param fallbackName Error class to use when `error` is not already a VideoError.
 */
export function asVideoError(
  error: unknown,
  fallbackName: new (message: string, options?: { hint?: string; cause?: unknown }) => VideoError,
  hint?: string,
): VideoError {
  if (error instanceof VideoError) return error;

  const message = error instanceof Error ? error.message : String(error);
  return new fallbackName(message, { ...(hint ? { hint } : {}), cause: error });
}

/** Best-effort message extraction, for wrapping foreign errors. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) {
    // Playwright prefixes its errors with a call log, which is verbose but genuinely useful.
    // The first line is the actual failure; the log is preserved in diagnostics instead.
    return error.message.split('\n')[0] ?? error.message;
  }
  return String(error);
}
