/**
 * The render error.
 *
 * The plan is blunt about this (§20): a failure must identify the scene, the action, the
 * selector, the URL, the elapsed time and where the diagnostics are. A bare `TimeoutError`
 * identifies none of them, and the cost of that is measured in debugging sessions.
 *
 * This is the error a caller catches. It wraps whatever the browser or the encoder threw and adds
 * the context that only the framework knows.
 */

import { VideoError } from './errors.js';

/** Where a failure happened, as far as the framework can tell. */
export interface RenderContext {
  /** Scene the script was inside, if any. */
  scene?: string | undefined;
  /** Action being performed, e.g. `click`. */
  action?: string | undefined;
  /** Selector or target the action used. */
  selector?: string | undefined;
  /** URL of the page at the time. */
  url?: string | undefined;
  /** Logical milliseconds elapsed when the failure occurred. */
  elapsedMs?: number | undefined;
}

/** Files written for a failed run, relative to the debug directory. */
export interface ArtifactList {
  screenshot?: string;
  trace?: string;
  console?: string;
  network?: string;
  manifest?: string;
  error?: string;
  /** Every raw frame, only when `debug.frames` is enabled. */
  frames?: string;
}

export class VideoRenderError extends VideoError {
  readonly context: RenderContext;
  readonly artifacts: ArtifactList;

  constructor(
    message: string,
    context: RenderContext = {},
    options: { hint?: string; cause?: unknown; artifacts?: ArtifactList } = {},
  ) {
    super(message, {
      ...(options.hint ? { hint: options.hint } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    });

    this.context = context;
    this.artifacts = options.artifacts ?? {};
  }

  /**
   * The multi-line report the CLI prints.
   *
   * Ordered so the most useful facts come first: what failed, where, and what to look at.
   * Everything optional is omitted rather than printed as "unknown", so the report never
   * teaches the reader to skim past it.
   */
  report(): string {
    const lines: string[] = [this.message];

    const { scene, action, selector, url, elapsedMs } = this.context;
    const where = [scene, action].filter(Boolean).join(' › ');
    if (where) lines.push(`  at: ${where}`);
    if (selector) lines.push(`  selector: ${selector}`);
    if (url) lines.push(`  url: ${url}`);
    if (elapsedMs !== undefined) lines.push(`  elapsed: ${formatDuration(elapsedMs)}`);

    if (this.hint) lines.push(`  hint: ${this.hint}`);

    const artifacts = Object.entries(this.artifacts).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    );
    if (artifacts.length > 0) {
      lines.push('  artefacts:');
      for (const [, path] of artifacts) lines.push(`    ${path}`);
    }

    return lines.join('\n');
  }

  /** Plain object form, for `error.json`. */
  override toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      hint: this.hint,
      context: this.context,
      artifacts: this.artifacts,
      ...(this.cause instanceof Error ? { cause: this.cause.message } : {}),
    };
  }
}

/**
 * Wrap anything thrown during a render in a {@link VideoRenderError}.
 *
 * An existing VideoRenderError is returned unchanged — re-wrapping would discard the context it
 * already carries in favour of the context at the point it was rethrown.
 */
export function asRenderError(
  error: unknown,
  context: RenderContext,
  artifacts: ArtifactList = {},
): VideoRenderError {
  if (error instanceof VideoRenderError) {
    // Fill in anything the thrower could not know, e.g. elapsed time.
    return new VideoRenderError(
      error.message,
      { ...error.context, ...definedOnly(context) },
      {
        ...(error.hint ? { hint: error.hint } : {}),
        ...(error.cause !== undefined ? { cause: error.cause } : {}),
        artifacts: { ...error.artifacts, ...artifacts },
      },
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return new VideoRenderError(message, context, { cause: error, artifacts });
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

/** Human-readable duration, for reports. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  return seconds < 60
    ? `${seconds.toFixed(2)}s`
    : `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(0)}s`;
}
