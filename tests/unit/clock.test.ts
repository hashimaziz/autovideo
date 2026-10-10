import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ClockStalledError, LogicalClock } from '../../src/runtime/clock.js';

/**
 * The clock is the framework's determinism guarantee in miniature: a given sequence of
 * `advanceTo` calls must always produce the same logical time, independent of wall-clock speed.
 */
describe('advanceTo', () => {
  it('starts at zero', () => {
    expect(new LogicalClock().now()).toBe(0);
  });

  it('moves forward and reports that it moved', () => {
    const clock = new LogicalClock();
    expect(clock.advanceTo(100)).toBe(true);
    expect(clock.now()).toBe(100);
  });

  it('refuses to move backwards', () => {
    // A backwards frame index would sample motion at an earlier state and visibly rewind.
    const clock = new LogicalClock();
    clock.advanceTo(500);
    expect(clock.advanceTo(200)).toBe(false);
    expect(clock.now()).toBe(500);
  });

  it('treats an equal timestamp as not an advance', () => {
    const clock = new LogicalClock();
    clock.advanceTo(500);
    expect(clock.advanceTo(500)).toBe(false);
  });

  it('rejects a non-finite value', () => {
    const clock = new LogicalClock();
    expect(() => clock.advanceTo(Number.NaN)).toThrow(TypeError);
    expect(() => clock.advanceTo(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});

describe('wait', () => {
  let clock: LogicalClock;

  beforeEach(() => {
    clock = new LogicalClock();
  });

  it('resolves only once time passes the deadline', async () => {
    let resolved = false;
    const waiting = clock.wait(500).then(() => {
      resolved = true;
    });

    clock.advanceTo(499);
    await Promise.resolve();
    expect(resolved).toBe(false);

    clock.advanceTo(500);
    await waiting;
    expect(resolved).toBe(true);
  });

  it('produces the same frame count regardless of how time is stepped', async () => {
    // The determinism claim in miniature: a 1000ms wait at 30fps must always span 30 frame
    // boundaries, whether time advances in one jump or thirty.
    const coarse = new LogicalClock();
    const coarseWait = coarse.wait(1000);
    for (let frame = 1; frame <= 30; frame++) coarse.advanceTo((frame / 30) * 1000);
    await coarseWait;

    const fine = new LogicalClock();
    const fineWait = fine.wait(1000);
    for (let frame = 1; frame <= 30; frame++) fine.advanceTo((frame / 30) * 1000);
    await fineWait;

    expect(coarse.now()).toBe(fine.now());
  });

  it('resolves immediately for a zero duration', async () => {
    await expect(clock.wait(0)).resolves.toBeUndefined();
    expect(clock.waits()).toEqual([{ startMs: 0, durationMs: 0, reason: 'wait' }]);
  });

  it('rejects a negative duration', () => {
    // A negative pause would rewind the video.
    expect(() => clock.wait(-1)).toThrow(RangeError);
  });

  it('rejects a non-finite duration', () => {
    expect(() => clock.wait(Number.NaN)).toThrow(TypeError);
  });

  it('tracks outstanding waiters', async () => {
    const waiting = clock.wait(100);
    expect(clock.pendingCount()).toBe(1);

    clock.advanceTo(100);
    await waiting;
    expect(clock.pendingCount()).toBe(0);
  });

  it('resolves several waiters in deadline order', async () => {
    const order: string[] = [];
    const first = clock.wait(100).then(() => order.push('first'));
    const second = clock.wait(200).then(() => order.push('second'));
    const third = clock.wait(300).then(() => order.push('third'));

    clock.advanceTo(300);
    await Promise.all([first, second, third]);

    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('measures a wait from the current time, never from zero', async () => {
    clock.advanceTo(1000);
    let resolved = false;
    const waiting = clock.wait(100).then(() => {
      resolved = true;
    });

    // Deadline is 1100, not 100. A wait must never be "already satisfied" by elapsed time,
    // because that would let a paused frame silently swallow a beat.
    await Promise.resolve();
    expect(resolved).toBe(false);

    clock.advanceTo(1100);
    await waiting;
    expect(clock.waits()).toEqual([{ startMs: 1000, durationMs: 100, reason: 'wait' }]);
  });
});

describe('wait records', () => {
  it('records start, duration and reason', async () => {
    const clock = new LogicalClock();
    clock.advanceTo(200);

    const waiting = clock.wait(300, 'pause');
    clock.advanceTo(500);
    await waiting;

    expect(clock.waits()).toEqual([{ startMs: 200, durationMs: 300, reason: 'pause' }]);
    expect(clock.waitedMs()).toBe(300);
  });

  it('accumulates across many pauses', async () => {
    const clock = new LogicalClock();
    for (let index = 0; index < 3; index++) {
      const waiting = clock.wait(100, `pause-${index}`);
      clock.advanceTo(clock.now() + 100);
      await waiting;
    }

    expect(clock.waits()).toHaveLength(3);
    expect(clock.waitedMs()).toBe(300);
  });
});

describe('stall handling', () => {
  it('rejects outstanding waits when the pump stops', async () => {
    const clock = new LogicalClock();
    const waiting = clock.wait(5000);

    clock.rejectPending('The frame pump stopped after an encoder crash.');

    await expect(waiting).rejects.toBeInstanceOf(ClockStalledError);
  });

  it('explains what stopped in the error message', async () => {
    const clock = new LogicalClock();
    clock.advanceTo(120);
    const waiting = clock.wait(5000);

    clock.rejectPending('The frame pump stopped after an encoder crash.');

    await expect(waiting).rejects.toThrow(/encoder crash/);
    await expect(waiting).rejects.toThrow(/stopped advancing at 120ms/);
  });

  it('rejects every outstanding waiter, not just the first', async () => {
    const clock = new LogicalClock();
    const waits = [clock.wait(1000), clock.wait(2000), clock.wait(3000)];

    clock.rejectPending('pump died');

    const results = await Promise.allSettled(waits);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected', 'rejected']);
  });

  it('leaves already-settled waits alone', async () => {
    const clock = new LogicalClock();
    const waiting = clock.wait(100);
    clock.advanceTo(100);
    await waiting;

    clock.rejectPending('pump died');

    expect(clock.waits()).toHaveLength(1);
  });

  it('fails a wait that outlives the stall guard', async () => {
    vi.useFakeTimers();
    try {
      const clock = new LogicalClock({ stallGuardMs: 50 });
      const waiting = clock.wait(5000, 'pause');

      const assertion = expect(waiting).rejects.toBeInstanceOf(ClockStalledError);
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire the stall guard on a wait that resolves in time', async () => {
    vi.useFakeTimers();
    try {
      const clock = new LogicalClock({ stallGuardMs: 50 });
      const waiting = clock.wait(100);

      clock.advanceTo(100);
      await vi.advanceTimersByTimeAsync(60);
      await expect(waiting).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('dispose', () => {
  it('drops outstanding waits', async () => {
    const clock = new LogicalClock();
    void clock.wait(5000);

    clock.dispose();

    expect(clock.pendingCount()).toBe(0);
  });

  it('is safe to call when nothing is pending', () => {
    expect(() => new LogicalClock().dispose()).not.toThrow();
  });
});
