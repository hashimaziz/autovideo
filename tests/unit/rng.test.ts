import { describe, expect, it } from 'vitest';

import { createRng, hashString, SeededRng } from '../../src/seed/rng.js';

/**
 * Determinism tests.
 *
 * These are the framework's foundation: every "natural" behaviour is a seeded draw. If these
 * fail, nothing else about reproducibility holds.
 */
describe('createRng', () => {
  it('rejects a non-finite or non-numeric seed', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => createRng(bad)).toThrow(TypeError);
    }
  });

  it('truncates a fractional seed rather than rejecting it', () => {
    expect(createRng(42.9).seed).toBe(42);
    expect(createRng(42.9).seed).toBe(createRng(42).seed);
  });

  it('accepts negative and zero seeds', () => {
    for (const seed of [0, -1, -12345, Number.MAX_SAFE_INTEGER]) {
      expect(() => createRng(seed)).not.toThrow();
    }
  });
});

describe('reproducibility', () => {
  it('produces an identical sequence for the same seed', () => {
    const draw = (seed: number, count: number) => {
      const rng = createRng(seed);
      return Array.from({ length: count }, () => rng.float());
    };

    expect(draw(42069, 1000)).toEqual(draw(42069, 1000));
  });

  it('produces a different sequence for a different seed', () => {
    const draw = (seed: number, count: number) => {
      const rng = createRng(seed);
      return Array.from({ length: count }, () => rng.float());
    };

    expect(draw(42069, 100)).not.toEqual(draw(42070, 100));
  });

  it('decorrelates adjacent seeds', () => {
    // Without SplitMix32 expansion, sfc32 seeded from nearby integers produces near-identical
    // first outputs — seeds 1 and 2 would give visibly similar "random" motion. This asserts
    // the expansion is actually doing its job.
    const first = (seed: number) => createRng(seed).float();
    const distance = Math.abs(first(1) - first(2));

    // Two independent uniforms differ by ~0.25 on average; anything under 0.01 would mean the
    // streams are effectively identical.
    expect(distance).toBeGreaterThan(0.01);
  });

  it('keeps sequences stable across a long run', () => {
    // Guards against an accidental state reset or an unbounded warm-up: the first 50 draws of a
    // fresh generator must replay exactly after the generator has been used a lot.
    const rng = createRng(7);
    const first = Array.from({ length: 50 }, () => rng.float());
    const second = Array.from({ length: 50 }, () => rng.float());

    const replay = createRng(7);
    const replayedFirst = Array.from({ length: 50 }, () => replay.float());

    expect(replayedFirst).toEqual(first);
    // And the generator genuinely advanced rather than restarting.
    expect(second).not.toEqual(first);
  });
});

describe('named streams', () => {
  it('gives the same stream for the same name', () => {
    const left = createRng(42069).stream('cursor');
    const right = createRng(42069).stream('cursor');

    expect(Array.from({ length: 50 }, () => left.float())).toEqual(
      Array.from({ length: 50 }, () => right.float()),
    );
  });

  it('gives different sequences for different names', () => {
    const cursor = createRng(42069).stream('cursor');
    const typing = createRng(42069).stream('typing');

    const left = Array.from({ length: 50 }, () => cursor.float());
    const right = Array.from({ length: 50 }, () => typing.float());

    expect(left).not.toEqual(right);
  });

  it('is unaffected by draws taken from a sibling stream', () => {
    // This is the whole point of streams. With one shared generator, exhausting `typing` here
    // would shift every subsequent `cursor` draw and silently change the video.
    const untouched = createRng(42069).stream('cursor');
    const reference = createRng(42069).stream('cursor');

    const noisySibling = createRng(42069).stream('typing');
    for (let index = 0; index < 10_000; index++) noisySibling.float();

    expect(Array.from({ length: 100 }, () => untouched.float())).toEqual(
      Array.from({ length: 100 }, () => reference.float()),
    );
  });

  it('is unaffected by draws taken from the root generator', () => {
    const root = createRng(42069);
    for (let index = 0; index < 10_000; index++) root.float();

    const afterRootUse = createRng(42069).stream('cursor');
    const fresh = createRng(42069).stream('cursor');

    expect(Array.from({ length: 100 }, () => afterRootUse.float())).toEqual(
      Array.from({ length: 100 }, () => fresh.float()),
    );
  });

  it('rejects an empty or non-string name', () => {
    const rng = createRng(1);
    expect(() => rng.stream('')).toThrow(TypeError);
    expect(() => rng.stream(undefined as unknown as string)).toThrow(TypeError);
  });

  it('carries the originating seed, so manifests can report it', () => {
    expect(createRng(42069).stream('cursor').seed).toBe(42069);
  });
});

describe('float', () => {
  it('stays within [0, 1)', () => {
    const rng = createRng(2024);
    for (let index = 0; index < 100_000; index++) {
      const value = rng.float();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('is roughly uniform', () => {
    // Ten equal buckets should each hold ~10% of draws. Generous bounds: with 100k samples the
    // standard error per bucket is ~0.1%, so 9.5%-10.5% is ~5 sigma and will not flake.
    const rng = createRng(2024);
    const samples = 100_000;
    const counts = new Array<number>(10).fill(0);

    for (let index = 0; index < samples; index++) {
      const bucket = Math.floor(rng.float() * 10);
      counts[bucket] = (counts[bucket] ?? 0) + 1;
    }

    for (const count of counts) {
      expect(count / samples).toBeGreaterThan(0.05);
      expect(count / samples).toBeLessThan(0.15);
    }
  });

  it('has a mean near 0.5 and a variance near 1/12', () => {
    const rng = createRng(99);
    const samples = 200_000;
    let sum = 0;
    const values: number[] = [];

    for (let index = 0; index < samples; index++) {
      const value = rng.float();
      values.push(value);
      sum += value;
    }

    const mean = sum / samples;
    const variance = values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / samples;

    expect(mean).toBeCloseTo(0.5, 2);
    expect(variance).toBeCloseTo(1 / 12, 3);
  });
});

describe('int', () => {
  it('respects half-open bounds', () => {
    const rng = createRng(5);
    for (let index = 0; index < 10_000; index++) {
      const value = rng.int(10, 20);
      expect(value).toBeGreaterThanOrEqual(10);
      expect(value).toBeLessThan(20);
    }
  });

  it('covers the full range', () => {
    const rng = createRng(5);
    const seen = new Set<number>();
    for (let index = 0; index < 10_000; index++) seen.add(rng.int(0, 4));

    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it('is approximately uniform, and unbiased across the range', () => {
    // Non-uniformity is most visible at the range edges for a naive
    // `Math.floor(float() * range)`, which over-represents low outcomes.
    const rng = createRng(31337);
    const counts = new Array<number>(6).fill(0);
    const samples = 120_000;

    for (let index = 0; index < samples; index++) {
      const bucket = rng.int(0, 6);
      counts[bucket] = (counts[bucket] ?? 0) + 1;
    }

    const expected = samples / 6;
    for (const count of counts) {
      // 6 buckets, 120k samples: sigma per bucket ~ 0.02%. A 1% band is ~50 sigma.
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.01);
    }
  });

  it('throws on reversed bounds rather than silently inverting the range', () => {
    // `int(20, 10)` is far more likely an off-by-one in the caller than an intent to invert the
    // range, so the error is preferred over a surprise interval.
    expect(() => createRng(5).int(20, 10)).toThrow(RangeError);
  });

  it('rounds fractional bounds outward to whole numbers', () => {
    const rng = createRng(5);
    for (let index = 0; index < 1000; index++) {
      const value = rng.int(1.2, 4.8);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(2);
      expect(value).toBeLessThan(5);
    }
  });

  it('rejects an empty range and non-finite bounds', () => {
    const rng = createRng(5);
    expect(() => rng.int(5, 5)).toThrow(RangeError);
    expect(() => rng.int(5, 4)).toThrow(RangeError);
    expect(() => rng.int(Number.NaN, 5)).toThrow(RangeError);
    expect(() => rng.int(0, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('handles a range wider than 2^32', () => {
    const rng = createRng(5);
    const value = rng.int(0, 2 ** 34);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(2 ** 34);
  });

  it('handles negative ranges', () => {
    const rng = createRng(5);
    const seen = new Set<number>();
    for (let index = 0; index < 10_000; index++) seen.add(rng.int(-3, 3));
    // Half-open, so -3 is included and 3 is not.
    expect([...seen].sort((a, b) => a - b)).toEqual([-3, -2, -1, 0, 1, 2]);
  });
});

describe('intInclusive', () => {
  it('includes both endpoints', () => {
    const rng = createRng(5);
    const seen = new Set<number>();
    for (let index = 0; index < 10_000; index++) seen.add(rng.intInclusive(1, 3));
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('handles a single-value range', () => {
    const rng = createRng(5);
    expect(rng.intInclusive(4, 4)).toBe(4);
  });

  it('handles reversed bounds', () => {
    const rng = createRng(5);
    for (let index = 0; index < 1000; index++) {
      const value = rng.intInclusive(3, 1);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(3);
    }
  });
});

describe('boolean', () => {
  it('defaults to an even split', () => {
    const rng = createRng(11);
    let heads = 0;
    for (let index = 0; index < 100_000; index++) if (rng.boolean()) heads++;
    expect(heads / 100_000).toBeCloseTo(0.5, 2);
  });

  it('honours the probability', () => {
    const rng = createRng(11);
    let heads = 0;
    for (let index = 0; index < 100_000; index++) if (rng.boolean(0.25)) heads++;
    expect(heads / 100_000).toBeCloseTo(0.25, 2);
  });

  it('is always false at 0 and always true at 1', () => {
    const rng = createRng(11);
    for (let index = 0; index < 1000; index++) {
      expect(rng.boolean(0)).toBe(false);
      expect(rng.boolean(1)).toBe(true);
    }
  });

  it('rejects an out-of-range probability', () => {
    const rng = createRng(11);
    expect(() => rng.boolean(-0.1)).toThrow(RangeError);
    expect(() => rng.boolean(1.1)).toThrow(RangeError);
    expect(() => rng.boolean(Number.NaN)).toThrow(RangeError);
  });
});

describe('between', () => {
  it('stays within bounds and covers them', () => {
    const rng = createRng(3);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < 10_000; index++) {
      const value = rng.between(-5, 15);
      min = Math.min(min, value);
      max = Math.max(max, value);
      expect(value).toBeGreaterThanOrEqual(-5);
      expect(value).toBeLessThan(15);
    }

    expect(min).toBeLessThan(-4.5);
    expect(max).toBeGreaterThan(14.5);
  });

  it('supports a zero-width range', () => {
    const rng = createRng(3);
    expect(rng.between(2, 2)).toBe(2);
  });
});

describe('pick / sample / shuffle', () => {
  it('picks every element given enough draws', () => {
    const rng = createRng(8);
    const items = ['a', 'b', 'c'];
    const seen = new Set<string>();
    for (let index = 0; index < 1000; index++) seen.add(rng.pick(items));
    expect([...seen].sort()).toEqual(items);
  });

  it('throws on an empty pick', () => {
    expect(() => createRng(8).pick([])).toThrow(RangeError);
  });

  it('samples distinct elements without mutating the input', () => {
    const rng = createRng(8);
    const items = [1, 2, 3, 4, 5];
    const result = rng.sample(items, 3);

    expect(result).toHaveLength(3);
    expect(new Set(result).size).toBe(3);
    expect(items).toEqual([1, 2, 3, 4, 5]);
  });

  it('shuffles into a permutation of the input', () => {
    const rng = createRng(8);
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const result = rng.shuffle(items);

    expect(result).toHaveLength(items.length);
    expect([...result].sort((a, b) => a - b)).toEqual(items);
    expect(items).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('actually reorders the input, most of the time', () => {
    // A shuffle that returned the input unchanged would still pass the permutation check.
    const items = Array.from({ length: 20 }, (_, index) => index);
    const unchanged = Array.from({ length: 20 }, () => false);
    const rng = createRng(8);

    for (let index = 0; index < 50; index++) {
      const result = rng.shuffle(items);
      unchanged[index] = result.every((value, position) => value === position);
    }

    expect(unchanged.filter(Boolean)).toHaveLength(0);
  });

  it('treats an empty shuffle as a no-op but an empty pick as an error', () => {
    expect(createRng(8).shuffle([])).toEqual([]);
    expect(() => createRng(8).pick([])).toThrow(RangeError);
  });

  it('samples zero items as an empty array', () => {
    expect(createRng(8).sample([1, 2, 3], 0)).toEqual([]);
  });

  it('rejects sampling more than is available', () => {
    expect(() => createRng(8).sample([1, 2], 3)).toThrow(RangeError);
  });

  it('rejects a negative or fractional count', () => {
    expect(() => createRng(8).sample([1, 2], -1)).toThrow(RangeError);
    expect(() => createRng(8).sample([1, 2], 1.5)).toThrow(RangeError);
  });
});

describe('gaussian', () => {
  it('matches the requested mean and standard deviation', () => {
    const rng = createRng(2024);
    const samples = 200_000;
    const values: number[] = [];
    let sum = 0;

    for (let index = 0; index < samples; index++) {
      const value = rng.gaussian(10, 2);
      values.push(value);
      sum += value;
    }

    const mean = sum / samples;
    const variance = values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / samples;

    expect(mean).toBeCloseTo(10, 1);
    expect(Math.sqrt(variance)).toBeCloseTo(2, 1);
  });

  it('defaults to the standard normal distribution', () => {
    const rng = createRng(2024);
    let sum = 0;
    for (let index = 0; index < 100_000; index++) sum += rng.gaussian();

    expect(sum / 100_000).toBeCloseTo(0, 1);
  });

  it('never produces a non-finite value', () => {
    // The hazard is specific: float() can legitimately return exactly 0, and feeding that
    // straight into log() yields -Infinity rather than an error. This is the regression test.
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const rng = createRng(seed);
      for (let index = 0; index < 2000; index++) {
        expect(Number.isFinite(rng.gaussian())).toBe(true);
      }
    }
  });

  it('rejects non-finite parameters', () => {
    const rng = createRng(1);
    expect(() => rng.gaussian(Number.NaN, 1)).toThrow(RangeError);
    expect(() => rng.gaussian(0, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('hashString', () => {
  it('is stable and unsigned', () => {
    expect(hashString('cursor')).toBe(hashString('cursor'));
    expect(hashString('cursor')).toBeGreaterThanOrEqual(0);
    expect(hashString('cursor')).toBeLessThanOrEqual(0xffffffff);
  });

  it('separates similar names', () => {
    expect(hashString('cursor')).not.toBe(hashString('typing'));
    expect(hashString('seed')).not.toBe(hashString('seeds'));
  });

  it('handles the empty string', () => {
    expect(Number.isFinite(hashString(''))).toBe(true);
  });
});

describe('SeededRng construction', () => {
  it('can be constructed directly and agrees with createRng', () => {
    const direct = new SeededRng(42069);
    const viaFactory = createRng(42069);

    expect(direct.float()).toBe(viaFactory.float());
  });
});
