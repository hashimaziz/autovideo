import { describe, expect, it } from 'vitest';

import {
  EASINGS,
  easeInCubic,
  easeInOutCubic,
  easeInOutSine,
  easeOutBack,
  easeOutCubic,
  easeOutQuart,
  easingByName,
  linear,
  type Easing,
} from '../../src/motion/easing.js';

const CURVES: Array<[string, Easing]> = [
  ['linear', linear],
  ['easeInCubic', easeInCubic],
  ['easeOutCubic', easeOutCubic],
  ['easeOutQuart', easeOutQuart],
  ['easeInOutCubic', easeInOutCubic],
  ['easeInOutSine', easeInOutSine],
];

describe('easing invariants', () => {
  it.each(CURVES)('%s starts at 0 and ends at 1', (_name, curve) => {
    // An animation that does not start where it was or end where it was asked to leaves a
    // visible jump, and at the end it would show a permanently wrong position.
    //
    // Compared approximately: easeOutBack(1) evaluates to 2.2e-16 rather than exactly 1, which
    // is invisible in a pixel but would fail an exact equality check forever.
    expect(curve(0)).toBeCloseTo(0, 12);
    expect(curve(1)).toBeCloseTo(1, 12);
  });

  it.each(CURVES)('%s is monotonic non-decreasing', (_name, curve) => {
    // Reversal reads as a glitch, not as personality. This is why `easeOutBack` is tested
    // separately: it deliberately overshoots.
    let previous = curve(0);
    for (let step = 1; step <= 1000; step++) {
      const value = curve(step / 1000);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = value;
    }
  });

  it.each(CURVES)('%s clamps out-of-range input', (_name, curve) => {
    // A sampled timestamp slightly outside the animation must never produce motion outside
    // the declared path.
    expect(curve(-5)).toBeCloseTo(0, 12);
    expect(curve(5)).toBeCloseTo(1, 12);
  });

  it.each(CURVES)('%s is continuous', (_name, curve) => {
    // A discontinuity would show as a single-frame jump. Sampling finely enough to catch one.
    let previous = curve(0);
    for (let step = 1; step <= 10_000; step++) {
      const value = curve(step / 10_000);
      expect(Math.abs(value - previous)).toBeLessThan(0.01);
      previous = value;
    }
  });

  it.each(CURVES)('%s produces only finite values', (_name, curve) => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      expect(Number.isFinite(curve(t))).toBe(true);
    }
  });
});

describe('easeInOutCubic', () => {
  it('is symmetric about the midpoint', () => {
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 10);
    expect(easeInOutCubic(0.25) + easeInOutCubic(0.75)).toBeCloseTo(1, 10);
  });

  it('moves slowly at both ends and fastest in the middle', () => {
    // The shape that makes a cursor look hand-driven rather than mechanical.
    const start = easeInOutCubic(0.05) - easeInOutCubic(0);
    const middle = easeInOutCubic(0.55) - easeInOutCubic(0.5);
    const end = easeInOutCubic(1) - easeInOutCubic(0.95);

    expect(middle).toBeGreaterThan(start);
    expect(middle).toBeGreaterThan(end);
  });

  it('matches the formula the reference implementation used', () => {
    // The scroll engine in the audited implementation hardcoded this curve. Keeping the exact
    // values means a scroll ported from it looks identical.
    expect(easeInOutCubic(0.25)).toBeCloseTo(4 * 0.25 ** 3, 10);
    expect(easeInOutCubic(0.75)).toBeCloseTo(1 - Math.pow(-2 * 0.75 + 2, 3) / 2, 10);
  });
});

describe('easeOutBack', () => {
  it('starts at 0 and returns exactly to 1', () => {
    expect(easeOutBack(0)).toBeCloseTo(0, 12);
    expect(easeOutBack(1)).toBeCloseTo(1, 12);
  });

  it('overshoots past 1 in the middle', () => {
    let peak = 0;
    for (let step = 0; step <= 1000; step++) peak = Math.max(peak, easeOutBack(step / 1000));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThan(1.2);
  });

  it('settles rather than touching 1 and leaving', () => {
    // A curve that peaks and returns within a frame is indistinguishable from no overshoot.
    expect(easeOutBack(0.7)).toBeGreaterThan(0.9);
    expect(easeOutBack(0.9)).toBeGreaterThan(1);
  });
});

describe('easingByName', () => {
  it('resolves every registered curve', () => {
    for (const name of Object.keys(EASINGS)) {
      expect(typeof easingByName(name)).toBe('function');
    }
  });

  it('returns the same function the map holds', () => {
    expect(easingByName('linear')).toBe(linear);
  });

  it('lists the alternatives when the name is unknown', () => {
    // A typo in a YAML video definition should fail with the valid options, not with
    // "undefined is not a function" three frames into a render.
    expect(() => easingByName('easeInOutBounce')).toThrow(/Available:.*easeInOutCubic/);
  });
});

describe('linear', () => {
  it('is the identity on [0, 1]', () => {
    expect(linear(0.25)).toBe(0.25);
    expect(linear(0.5)).toBe(0.5);
    expect(linear(0.75)).toBe(0.75);
  });
});
