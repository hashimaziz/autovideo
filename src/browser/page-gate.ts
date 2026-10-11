/**
 * A gate that serialises page access.
 *
 * ### Why this exists
 *
 * The frame pump and the user's script both drive the same page, concurrently. That is fine for
 * ordinary mutations — a screenshot taken while a click is landing still produces a coherent
 * frame — but it is not fine for navigation.
 *
 * Every CDP and page call *hangs* while a navigation is in flight rather than failing. This was
 * measured, not assumed. So if the script calls `open()` at the moment the pump is inside a
 * `page.evaluate`, that evaluate never returns, the frame pump never advances, and every pending
 * `clock.wait` sits there until the stall guard fires 30 seconds later reporting "no frames were
 * produced" — which points at the pump rather than at the navigation that caused it.
 *
 * Checking for an in-flight navigation before each call is not enough: the navigation can start
 * *during* the call. The only reliable answer is to ensure it cannot.
 *
 * ### The rule
 *
 * The gate is held for the duration of any work that touches the page. Navigation waits for the
 * gate with *priority*, so it cannot be starved by a pump that immediately re-acquires between
 * frames. Everything else is fair game.
 *
 * ### Why `tryAcquire` exists
 *
 * A page call can hang indefinitely, so the frame pump must be able to give up waiting for the
 * gate. Giving up naively is a trap: if the abandoned caller stays queued, the next `release()`
 * hands it the gate, and the gate is now held by nobody who will ever let go. Everything queues
 * behind that ghost forever. So a timed-out acquisition must *remove itself* from the queue.
 */

/** Sentinel for a gate acquisition that ran out of time. */
const GATE_TIMED_OUT = Symbol('gate-timed-out');

interface Waiter {
  resolve: () => void;
  priority: boolean;
  /** Set once the waiter has been removed from the queue, so release cannot hand off to it. */
  cancelled: boolean;
}

export class PageGate {
  #held = false;

  #waiters: Waiter[] = [];

  /** Wait for exclusive access to the page. */
  async acquire(priority = false): Promise<void> {
    if (!this.#held && this.#waiters.length === 0) {
      this.#held = true;
      return;
    }
    await this.#enqueue(priority);
  }

  /**
   * Acquire the gate, giving up after `timeoutMs`.
   *
   * A timed-out attempt removes itself from the queue. Without that, the eventual `release()`
   * would transfer ownership to an abandoned waiter and the gate would be held forever.
   *
   * @returns `true` if the gate is now held by this caller.
   */
  async tryAcquire(timeoutMs = Number.POSITIVE_INFINITY, priority = false): Promise<boolean> {
    // Fast path, exactly as in `acquire`. Missing this is a deadlock: enqueueing while the gate
    // is free waits for a `release()` that will never come, because nobody holds it.
    if (!this.#held && this.#waiters.length === 0) {
      this.#held = true;
      return true;
    }

    if (timeoutMs === Number.POSITIVE_INFINITY) {
      await this.#enqueue(priority);
      return true;
    }

    const enqueued = this.#enqueue(priority);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<typeof GATE_TIMED_OUT>((resolve) => {
      // Deliberately not unref'd: this timer is what unblocks a timed-out acquisition.
      timer = setTimeout(() => resolve(GATE_TIMED_OUT), timeoutMs);
    });

    try {
      const result = await Promise.race([enqueued.promise, expiry]);
      return result !== GATE_TIMED_OUT;
    } finally {
      if (timer) clearTimeout(timer);
      if (enqueued.waiter.cancelled) return false;
      // Timed out: withdraw from the queue so the gate cannot be handed to a ghost.
      enqueued.cancel();
      // Swallow the eventual resolution: nobody is waiting on it any more.
      void enqueued.promise.catch(() => undefined);
    }
  }

  /** Release the gate, handing it to the next live waiter. */
  release(): void {
    // Find the highest-priority live waiter. Selecting here rather than relying on insertion
    // order makes the guarantee explicit and independent of how a waiter was queued.
    let chosen = -1;
    for (let index = 0; index < this.#waiters.length; index++) {
      const waiter = this.#waiters[index];
      if (!waiter || waiter.cancelled) continue;
      if (waiter.priority) {
        chosen = index;
        break;
      }
      if (chosen === -1) chosen = index;
    }

    if (chosen === -1) {
      // Everyone left was cancelled — a timed-out attempt that has withdrawn.
      this.#waiters.length = 0;
      this.#held = false;
      return;
    }

    const [next] = this.#waiters.splice(chosen, 1);
    if (next) next.resolve();
    // Ownership transfers directly; `#held` stays true.
  }

  /** Run `body` with the gate held, releasing it even if `body` throws. */
  async withLock<T>(body: () => Promise<T>, priority = false): Promise<T> {
    await this.acquire(priority);
    try {
      return await body();
    } finally {
      this.release();
    }
  }

  /** Whether the gate is currently held. Diagnostic only. */
  isHeld(): boolean {
    return this.#held;
  }

  /** Queued callers waiting for the gate. Diagnostic only. */
  queueLength(): number {
    return this.#waiters.length;
  }

  /** Add a waiter to the queue and return a handle that can withdraw it. */
  #enqueue(priority: boolean): { promise: Promise<void>; waiter: Waiter; cancel: () => void } {
    let waiter!: Waiter;

    const promise = new Promise<void>((resolve) => {
      waiter = { resolve, priority, cancelled: false };
      // Navigation goes to the front so it cannot be starved by a pump that re-acquires the
      // gate between every frame.
      if (priority) this.#waiters.unshift(waiter);
      else this.#waiters.push(waiter);
    });

    return {
      promise,
      waiter,
      cancel: () => {
        if (waiter.cancelled) return;
        waiter.cancelled = true;
        const index = this.#waiters.indexOf(waiter);
        if (index !== -1) this.#waiters.splice(index, 1);
      },
    };
  }
}
