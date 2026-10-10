/**
 * The logical clock.
 *
 * ### Why video time is not wall-clock time
 *
 * The obvious design is to read the wall clock and turn elapsed milliseconds into a frame index.
 * That produces a video whose *content* is right but whose *timing* depends on the machine: if
 * the box is slow enough that a frame takes longer than 1/30s to capture, frames get dropped,
 * and how many get dropped changes with CPU load, thermal state and what else is running.
 *
 * So this clock does the opposite. It is driven **forward by the frame pump**, one frame at a
 * time, and never by `Date.now()`:
 *
 *   frame index n  ->  logical time n / fps  ->  clock.advanceTo(...)
 *
 * The consequence is that a `pause(1000)` always produces exactly 30 frames at 30fps, on any
 * machine, however slow. If capture cannot keep up, the render simply takes longer in wall-clock
 * terms — which the plan explicitly permits (§27: "a render can take longer than the final
 * video's duration").
 *
 * This is also what makes the whole video a pure function of the script and the seed. Nothing in
 * the output depends on how fast the hardware was.
 *
 * ### What this means for the API
 *
 * - `wait(ms)` resolves when *logical* time has advanced past the deadline. The pump keeps
 *   emitting frames in the meantime, so the pause renders as real stillness.
 * - Browser-side waits (`waitForSelector`) still consume real wall-clock time, but they do not
 *   by themselves advance video time — only captured frames do. A slow page therefore makes the
 *   render slower without making the video longer.
 *
 * The clock is pure and synchronous. Stall detection — "the pump stopped, so nothing will ever
 * advance this again" — lives in the pump, which is the only component that knows whether frames
 * are still being produced. What the clock offers is `rejectPending`, so the pump can fail every
 * outstanding wait instead of leaving the render hanging.
 */

/**
 * How long a wait may sit unresolved before it is presumed stalled.
 *
 * Generous relative to any realistic frame interval: a legitimately slow capture (large
 * viewport, heavy page, cold ffmpeg) must never be mistaken for a dead pump.
 */
export const STALL_GUARD_MS = 30_000;

/** A `wait()` that has not yet reached its deadline. */
interface PendingWait {
  deadlineMs: number;
  startMs: number;
  durationMs: number;
  reason: string;
  settle(): void;
  fail(error: Error): void;
  guard: ReturnType<typeof setTimeout>;
}

/** One completed wait, recorded so the manifest can account for the video's duration. */
export interface WaitRecord {
  /** Logical start, in milliseconds. */
  startMs: number;
  /** Logical duration, in milliseconds. */
  durationMs: number;
  /** Why the script waited. Surfaced in manifests and diagnostics. */
  reason: string;
}

/** Injectable timers, so the unit suite can drive stall behaviour without waiting 30 seconds. */
export interface ClockScheduler {
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface LogicalClockOptions {
  scheduler?: ClockScheduler;
  /** Overrides {@link STALL_GUARD_MS}. Tests only. */
  stallGuardMs?: number;
}

/**
 * Thrown when a wait cannot be satisfied because video time stopped advancing.
 *
 * Without this, a stopped pump turns every pending `wait()` into a promise that never settles,
 * and the failure surfaces as a hung render rather than as a diagnosable one.
 */
export class ClockStalledError extends Error {
  constructor(
    readonly deadlineMs: number,
    readonly stalledAtMs: number,
    readonly reason: string,
  ) {
    super(
      `Video time stopped advancing at ${stalledAtMs}ms while waiting for ${deadlineMs}ms. ${reason}`,
    );
    this.name = 'ClockStalledError';
  }
}

export class LogicalClock {
  #currentMs = 0;

  #pending: PendingWait[] = [];

  readonly #records: WaitRecord[] = [];

  readonly #scheduler: ClockScheduler;

  readonly #stallGuardMs: number;

  constructor(options: LogicalClockOptions = {}) {
    this.#scheduler = options.scheduler ?? {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle),
    };
    this.#stallGuardMs = options.stallGuardMs ?? STALL_GUARD_MS;
  }

  /** Current logical time in milliseconds. Starts at 0. */
  now(): number {
    return this.#currentMs;
  }

  /** Number of waits that have not yet reached their deadline. */
  pendingCount(): number {
    return this.#pending.length;
  }

  /** Every completed wait, oldest first. */
  waits(): readonly WaitRecord[] {
    return this.#records;
  }

  /** Total logical time spent in explicit waits. */
  waitedMs(): number {
    return this.#records.reduce((total, record) => total + record.durationMs, 0);
  }

  /**
   * Advance logical time.
   *
   * Monotonic by construction: moving backwards is refused, because a frame index that went
   * backwards would sample motion at an earlier state and visibly rewind the video.
   *
   * @returns `true` if time actually moved, `false` if the request was not a forward advance.
   */
  advanceTo(ms: number): boolean {
    if (!Number.isFinite(ms)) {
      throw new TypeError(`clock.advanceTo() requires a finite value (got ${String(ms)}).`);
    }
    if (ms <= this.#currentMs) return false;

    this.#currentMs = ms;
    this.#releaseReadyWaiters();
    return true;
  }

  /**
   * Wait until logical time reaches `now() + ms`.
   *
   * Resolves as soon as the pump advances past the deadline. Consumes no wall-clock time itself
   * and never busy-waits.
   *
   * @param reason Recorded in the manifest, e.g. `'pause'` or `'settle'`.
   * @throws {RangeError} for a negative or non-finite duration.
   * @throws {ClockStalledError} if video time stops advancing first.
   */
  wait(durationMs: number, reason = 'wait'): Promise<void> {
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) {
      throw new TypeError(`clock.wait() requires a finite duration (got ${String(durationMs)}).`);
    }
    if (durationMs < 0) {
      // A negative pause would move logical time backwards and rewind the video.
      throw new RangeError(`clock.wait() requires a non-negative duration (got ${durationMs}).`);
    }

    const startMs = this.#currentMs;

    if (durationMs === 0) {
      this.#records.push({ startMs, durationMs: 0, reason });
      return Promise.resolve();
    }

    const deadlineMs = startMs + durationMs;

    return new Promise<void>((resolve, reject) => {
      const pending: PendingWait = {
        deadlineMs,
        startMs,
        durationMs,
        reason,
        settle: () => {
          this.#records.push({ startMs, durationMs, reason });
          resolve();
        },
        fail: reject,
        // Populated immediately below; the closure only reads it when it fires.
        guard: undefined as unknown as ReturnType<typeof setTimeout>,
      };

      pending.guard = this.#scheduler.setTimeout(() => {
        this.#forget(pending);
        reject(
          new ClockStalledError(
            deadlineMs,
            this.#currentMs,
            `No frames were produced for ${this.#stallGuardMs}ms.`,
          ),
        );
      }, this.#stallGuardMs);

      // Never hold the process open on account of a stall guard.
      pending.guard.unref?.();

      this.#pending.push(pending);
    });
  }

  /**
   * Fail every outstanding wait, because video time will never advance again.
   *
   * Called by the pump when frame production stops. Rejecting rather than leaving promises
   * pending is what turns a dead render into a reported error.
   *
   * @param reason Appended to each rejection so the CLI can explain what stopped.
   */
  rejectPending(reason: string): void {
    const outstanding = this.#pending;
    this.#pending = [];

    for (const pending of outstanding) {
      this.#scheduler.clearTimeout(pending.guard);
      pending.fail(new ClockStalledError(pending.deadlineMs, this.#currentMs, reason));
    }
  }

  /** Drop outstanding waiters without settling them. Used on teardown. */
  dispose(): void {
    for (const pending of this.#pending) {
      this.#scheduler.clearTimeout(pending.guard);
    }
    this.#pending = [];
  }

  /** Remove one waiter from the queue and cancel its guard. */
  #forget(pending: PendingWait): void {
    this.#scheduler.clearTimeout(pending.guard);
    this.#pending = this.#pending.filter((entry) => entry !== pending);
  }

  /** Settle every waiter whose deadline has passed. */
  #releaseReadyWaiters(): void {
    if (this.#pending.length === 0) return;

    const stillWaiting: PendingWait[] = [];

    for (const pending of this.#pending) {
      if (pending.deadlineMs > this.#currentMs) {
        stillWaiting.push(pending);
        continue;
      }
      this.#scheduler.clearTimeout(pending.guard);
      pending.settle();
    }

    this.#pending = stillWaiting;
  }
}
