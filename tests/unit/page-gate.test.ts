import { describe, expect, it } from 'vitest';

import { PageGate } from '../../src/browser/page-gate.js';

/**
 * PageGate is load-bearing.
 *
 * Every CDP and page call *hangs* rather than fails while a navigation is in flight, and the
 * frame pump and the user's script drive the same page concurrently. Navigation therefore takes
 * the gate with priority, so the pump re-acquiring it between every frame cannot postpone a
 * navigation indefinitely.
 *
 * A defect here does not merely slow a render down — it reintroduces the intermittent hang this
 * gate was written to prevent.
 */
describe('PageGate', () => {
  /** Let queued continuations run. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('starts free', () => {
    const gate = new PageGate();
    expect(gate.isHeld()).toBe(false);
    expect(gate.queueLength()).toBe(0);
  });

  it('grants immediately when free', async () => {
    const gate = new PageGate();
    await gate.acquire();
    expect(gate.isHeld()).toBe(true);
  });

  it('blocks a second caller until released', async () => {
    const gate = new PageGate();
    await gate.acquire();

    let granted = false;
    const waiting = gate.acquire().then(() => {
      granted = true;
    });

    await settle();
    expect(granted).toBe(false);

    gate.release();
    await waiting;
    expect(granted).toBe(true);
  });

  it('hands the gate to exactly one waiter per release', async () => {
    const gate = new PageGate();
    await gate.acquire();

    const order: string[] = [];
    const first = gate.acquire().then(() => order.push('first'));
    const second = gate.acquire().then(() => order.push('second'));

    gate.release();
    await settle();
    expect(order).toEqual(['first']);

    gate.release();
    await settle();
    expect(order).toEqual(['first', 'second']);

    gate.release();
    expect(gate.isHeld()).toBe(false);
    await Promise.all([first, second]);
  });

  it('serves waiters in the order they queued', async () => {
    const gate = new PageGate();
    await gate.acquire();

    const order: number[] = [];
    const waiters = [1, 2, 3, 4].map((id) => gate.acquire().then(() => order.push(id)));
    for (let index = 0; index < 4; index++) {
      gate.release();
      await settle();
    }
    await Promise.all(waiters);

    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('serves a priority waiter ahead of one already queued', async () => {
    const gate = new PageGate();
    await gate.acquire();

    const order: string[] = [];
    const ordinary = gate.acquire().then(() => order.push('ordinary'));
    const navigation = gate.acquire(true).then(() => order.push('navigation'));

    gate.release();
    await settle();
    expect(order).toEqual(['navigation']);

    gate.release();
    await Promise.all([ordinary, navigation]);
    expect(order).toEqual(['navigation', 'ordinary']);
  });

  it('does not let a pump starve navigation across several frames', async () => {
    const gate = new PageGate();
    await gate.acquire();

    const order: string[] = [];
    // The realistic contention: a frame is rendered, then a navigation arrives.
    const frame = gate.acquire().then(() => order.push('frame'));
    const navigation = gate.acquire(true).then(() => order.push('navigation'));
    const nextFrame = gate.acquire().then(() => order.push('next-frame'));

    gate.release();
    await settle();
    gate.release();
    await settle();
    gate.release();
    await Promise.all([frame, navigation, nextFrame]);

    expect(order.indexOf('navigation')).toBeLessThan(order.indexOf('next-frame'));
  });

  describe('tryAcquire', () => {
    it('grants immediately when free', async () => {
      const gate = new PageGate();
      // Not queued behind a release that will never come.
      expect(await gate.tryAcquire(50)).toBe(true);
      expect(gate.isHeld()).toBe(true);
    });

    it('gives up after its deadline', async () => {
      const gate = new PageGate();
      await gate.acquire();
      expect(await gate.tryAcquire(20)).toBe(false);
    });

    it('withdraws a timed-out waiter so it cannot become a ghost owner', async () => {
      // The failure this guards is total rather than gradual: if an abandoned waiter stayed
      // queued, the next release would hand it the gate, and the gate would then be held by
      // nobody who will ever let go. Everything queues behind that forever and the render
      // produces no frames at all.
      const gate = new PageGate();
      await gate.acquire();

      expect(await gate.tryAcquire(20)).toBe(false);
      expect(gate.queueLength()).toBe(0);

      gate.release();
      expect(gate.isHeld()).toBe(false);
      expect(await gate.tryAcquire(100)).toBe(true);
    });

    it('leaves the gate free when several attempts time out', async () => {
      const gate = new PageGate();
      await gate.acquire();

      expect(await gate.tryAcquire(10)).toBe(false);
      expect(await gate.tryAcquire(10)).toBe(false);
      expect(gate.queueLength()).toBe(0);

      gate.release();
      expect(gate.isHeld()).toBe(false);
    });

    it('grants when the gate frees before the deadline', async () => {
      const gate = new PageGate();
      await gate.acquire();

      const pending = gate.tryAcquire(500);
      await settle();
      gate.release();

      expect(await pending).toBe(true);
      expect(gate.isHeld()).toBe(true);
    });
  });

  describe('withLock', () => {
    it('holds the gate for the duration of the body', async () => {
      const gate = new PageGate();
      let heldDuringBody = false;

      await gate.withLock(async () => {
        heldDuringBody = gate.isHeld();
      });

      expect(heldDuringBody).toBe(true);
      expect(gate.isHeld()).toBe(false);
    });

    it('releases even when the body throws', async () => {
      // A leaked gate here is fatal to every later frame, so this is asserted rather than
      // assumed.
      const gate = new PageGate();

      await expect(
        gate.withLock(() => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect(gate.isHeld()).toBe(false);
      expect(await gate.tryAcquire(50)).toBe(true);
    });

    it('serialises concurrent bodies', async () => {
      const gate = new PageGate();
      let concurrent = 0;
      let overlapped = false;

      const body = async (): Promise<void> => {
        concurrent++;
        if (concurrent > 1) overlapped = true;
        await settle();
        concurrent--;
      };

      await Promise.all([gate.withLock(body), gate.withLock(body), gate.withLock(body)]);

      expect(overlapped).toBe(false);
      expect(gate.isHeld()).toBe(false);
    });
  });
});
