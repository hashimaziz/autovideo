import { describe, expect, it } from 'vitest';

import { easeInOutCubic, easeOutCubic } from '../../src/motion/easing.js';
import { sampleHighlight } from '../../src/video/index.js';
import {
  clamp,
  distance,
  lerp,
  lerpPoint,
  progressAt,
  sampleAt,
  travelDuration,
} from '../../src/motion/interpolation.js';
import {
  animateNumber,
  animatePoint,
  constant,
  isFinished,
  MotionTrack,
} from '../../src/motion/track.js';

describe('progressAt', () => {
  it('is 0 before the start, 1 at the end', () => {
    expect(progressAt(1000, 500, 999)).toBe(0);
    expect(progressAt(1000, 500, 1500)).toBe(1);
  });

  it('rises linearly between', () => {
    expect(progressAt(0, 1000, 250)).toBeCloseTo(0.25, 10);
    expect(progressAt(0, 1000, 750)).toBeCloseTo(0.75, 10);
  });

  it('stays at 1 after the end', () => {
    expect(progressAt(0, 1000, 2000)).toBe(1);
    expect(progressAt(0, 1000, 1e9)).toBe(1);
  });

  it('treats a zero-duration animation as immediately complete', () => {
    // A zero-length animation is an instant change of value, so it is complete at every
    // timestamp. Anything else would divide by zero.
    expect(progressAt(500, 0, 500)).toBe(1);
    expect(progressAt(500, 0, 400)).toBe(1);
  });
});

describe('lerp', () => {
  it('interpolates between two values', () => {
    expect(lerp(0, 100, 0)).toBe(0);
    expect(lerp(0, 100, 0.5)).toBe(50);
    expect(lerp(0, 100, 1)).toBe(100);
  });

  it('handles descending ranges', () => {
    expect(lerp(100, 0, 0.5)).toBe(50);
  });

  it('applies the supplied easing', () => {
    expect(lerp(0, 100, 0.5, easeInOutCubic)).toBeCloseTo(50, 10);
    expect(lerp(0, 100, 0.25, easeOutCubic)).toBeCloseTo(easeOutCubic(0.25) * 100, 10);
  });

  it('clamps rather than extrapolating outside [0, 1]', () => {
    // Motion outside the declared path is always wrong: a sampled timestamp slightly before an
    // animation's start must not move anything.
    expect(lerp(0, 100, -0.5, (t) => t)).toBe(-50);
    // The default easing clamps, which is the guarantee that matters.
    expect(lerp(0, 100, -0.5)).toBe(0);
    expect(lerp(0, 100, 1.5)).toBe(100);
  });
});

describe('lerpPoint', () => {
  it('interpolates both axes', () => {
    expect(lerpPoint({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.5)).toEqual({ x: 5, y: 10 });
  });
});

describe('sampleAt', () => {
  it('evaluates a callback at eased progress', () => {
    expect(sampleAt(0, 1000, 500, (t) => t * 100)).toBe(50);
    expect(sampleAt(0, 1000, 500, (t) => t * 100, easeInOutCubic)).toBeCloseTo(50, 10);
  });
});

describe('distance and travelDuration', () => {
  it('measures Euclidean distance', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it('scales duration with distance', () => {
    const near = travelDuration({ x: 0, y: 0 }, { x: 90, y: 0 });
    const far = travelDuration({ x: 0, y: 0 }, { x: 900, y: 0 });

    expect(far).toBeCloseTo(near * 10, 6);
  });

  it('is zero for no movement', () => {
    expect(travelDuration({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe(0);
  });
});

describe('clamp', () => {
  it('bounds on both sides', () => {
    expect(clamp(50, 0, 100)).toBe(50);
    expect(clamp(-10, 0, 100)).toBe(0);
    expect(clamp(200, 0, 100)).toBe(100);
  });

  it('handles an inverted range without throwing', () => {
    expect(clamp(5, 100, 0)).toBe(100);
  });
});

describe('constant', () => {
  it('always yields its value regardless of time', () => {
    const animation = constant(42);
    expect(animation(0)).toBe(42);
    expect(animation(1e9)).toBe(42);
  });
});

describe('animateNumber', () => {
  it('starts and ends exactly at the endpoints', () => {
    const animation = animateNumber(0, 1000, 20, 80);
    expect(animation(0)).toBe(20);
    expect(animation(1000)).toBe(80);
  });

  it('is a pure function of time, independent of call order', () => {
    // The property the frame pump depends on: frame N can be rendered at any moment without
    // regard to which frames came before it.
    const forwards = animateNumber(0, 1000, 0, 100, easeInOutCubic);
    const backwards = animateNumber(0, 1000, 0, 100, easeInOutCubic);

    // Same timestamps, queried in a different order. If the animation carried internal state,
    // the second run would not match.
    backwards(300);
    backwards(200);
    const a = [0, 100, 200, 300].map(forwards);
    const b = [0, 100, 200, 300].map(backwards);

    expect(a).toEqual(b);
  });

  it('holds its endpoints outside the animation window', () => {
    const animation = animateNumber(500, 1500, 10, 20);
    expect(animation(0)).toBe(10);
    expect(animation(5000)).toBe(20);
  });

  it('handles a zero-length animation without dividing by zero', () => {
    const animation = animateNumber(100, 100, 5, 9);
    expect(Number.isFinite(animation(100))).toBe(true);
  });
});

describe('animatePoint', () => {
  it('starts and ends exactly on the endpoints', () => {
    const animation = animatePoint(0, 1000, { x: 0, y: 0 }, { x: 100, y: 50 });
    expect(animation(0)).toEqual({ x: 0, y: 0 });
    expect(animation(1000)).toEqual({ x: 100, y: 50 });
  });

  it('travels a straight line when bow is zero', () => {
    const animation = animatePoint(0, 1000, { x: 0, y: 0 }, { x: 100, y: 0 }, { bow: 0 });
    expect(animation(500)).toEqual({ x: 50, y: 0 });
  });

  it('bulges off the straight line when bowed', () => {
    const straight = animatePoint(0, 1000, { x: 0, y: 0 }, { x: 100, y: 0 }, { bow: 0 });
    const bowed = animatePoint(0, 1000, { x: 0, y: 0 }, { x: 100, y: 0 }, { bow: 0.08 });

    const straightMid = straight(500);
    const bowedMid = bowed(500);

    expect(bowedMid.x).toBeCloseTo(straightMid.x, 6);
    expect(Math.abs(bowedMid.y)).toBeGreaterThan(0.5);
  });

  it('curves the same way for the same endpoints every time', () => {
    // The bow direction is derived from the endpoints, not from elapsed time. Deriving it from
    // time would make the path differ frame to frame and read as the cursor wobbling.
    const a = animatePoint(0, 1000, { x: 0, y: 0 }, { x: 100, y: 20 }, { bow: 0.1 });
    const b = animatePoint(0, 1000, { x: 0, y: 0 }, { x: 100, y: 20 }, { bow: 0.1 });

    expect(a(600)).toEqual(b(600));
    expect(a(600).y).toBe(b(600).y);
  });

  it('handles identical endpoints without dividing by zero', () => {
    const animation = animatePoint(0, 1000, { x: 5, y: 5 }, { x: 5, y: 5 }, { bow: 0.1 });
    expect(animation(500)).toEqual({ x: 5, y: 5 });
  });
});

describe('MotionTrack', () => {
  it('starts with the cursor hidden at the origin', () => {
    const track = new MotionTrack();
    expect(track.sample(0)).toEqual({
      cursor: { x: 0, y: 0 },
      cursorVisible: false,
      scrollY: 0,
    });
  });

  it('samples every property together', () => {
    const track = new MotionTrack();
    track.setCursor(animatePoint(0, 1000, { x: 0, y: 0 }, { x: 100, y: 0 }));
    track.setCursorVisible(constant(true));
    track.setScrollY(animateNumber(0, 1000, 0, 500));

    expect(track.sample(500)).toEqual({
      cursor: { x: 50, y: 0 },
      cursorVisible: true,
      scrollY: 250,
    });
  });

  it('supersedes an earlier animation for the same property', () => {
    // Actions are sequential, so most recent is also most relevant: a new cursor move takes
    // over rather than fighting an unfinished one.
    const track = new MotionTrack();
    track.setCursor(animatePoint(0, 10_000, { x: 0, y: 0 }, { x: 1000, y: 0 }));
    track.setCursor(animatePoint(0, 100, { x: 0, y: 0 }, { x: 10, y: 0 }));

    expect(track.sampleCursor(100)).toEqual({ x: 10, y: 0 });
  });

  it('leaves other properties untouched when one is replaced', () => {
    const track = new MotionTrack();
    track.setScrollY(constant(200));
    track.setCursorVisible(constant(true));
    track.setCursor(constant({ x: 1, y: 1 }));

    track.setCursor(constant({ x: 2, y: 2 }));

    expect(track.sampleScrollY(0)).toBe(200);
    expect(track.sampleCursorVisible(0)).toBe(true);
    expect(track.sampleCursor(0)).toEqual({ x: 2, y: 2 });
  });

  it('can sample individual properties', () => {
    const track = new MotionTrack();
    track.setCursor(constant({ x: 3, y: 4 }));

    expect(track.sampleCursor(0)).toEqual({ x: 3, y: 4 });
  });

  it('produces identical state for identical timestamps across separate tracks', () => {
    // The whole reproducibility claim, in miniature: two runs built the same way produce the
    // same motion.
    const build = () => {
      const track = new MotionTrack();
      track.setCursor(
        animatePoint(
          0,
          2000,
          { x: 10, y: 10 },
          { x: 400, y: 600 },
          { bow: 0.05, easing: easeInOutCubic },
        ),
      );
      track.setScrollY(animateNumber(0, 2000, 0, 3000, easeInOutCubic));
      return track;
    };

    const a = build();
    const b = build();

    for (let frame = 0; frame < 60; frame++) {
      expect(a.sample(frame * 33.33)).toEqual(b.sample(frame * 33.33));
    }
  });
});

describe('isFinished', () => {
  it('is false before the end and true at or after it', () => {
    expect(isFinished(0, 1000, 999)).toBe(false);
    expect(isFinished(0, 1000, 1000)).toBe(true);
    expect(isFinished(0, 1000, 1001)).toBe(true);
  });
});

describe('highlight fade sampling', () => {
  // The fade is sampled in Node from logical time rather than animated by a CSS transition, so
  // these values are what decide the opacity of every frame. A transition would land differently
  // on a slower machine; this cannot.
  const hold = (fadeFromMs: number, fadeOutMs: number | null, fadeMs = 180) => ({
    fadeFromMs,
    fadeOutMs,
    options: { fadeMs },
  });

  it('is transparent at the moment it starts', () => {
    expect(sampleHighlight(hold(1000, null), 1000)).toBe(0);
  });

  it('is halfway through the fade at its midpoint', () => {
    expect(sampleHighlight(hold(1000, null), 1090)).toBeCloseTo(0.5, 5);
  });

  it('reaches full opacity and stays there', () => {
    expect(sampleHighlight(hold(1000, null), 1180)).toBe(1);
    expect(sampleHighlight(hold(1000, null), 9000)).toBe(1);
  });

  it('never leaves the 0-1 range before the fade-in completes', () => {
    // A clock that has not advanced past the start must not produce a negative opacity, which
    // would clamp to 0 and make the ring blink.
    expect(sampleHighlight(hold(1000, null), 0)).toBe(0);
  });

  it('fades back down after the fade-out begins', () => {
    expect(sampleHighlight(hold(1000, 2000), 2090)).toBeCloseTo(0.5, 5);
    expect(sampleHighlight(hold(1000, 2000), 2180)).toBe(0);
    expect(sampleHighlight(hold(1000, 2000), 5000)).toBe(0);
  });

  it('multiplies through a fade-out that overlaps the fade-in', () => {
    // Clearing immediately would otherwise subtract two in-progress values and invert through
    // zero, making the ring disappear and reappear.
    const value = sampleHighlight(hold(1000, 1050), 1065);

    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  });

  it('treats a zero fade as instant rather than dividing by zero', () => {
    // A zero fade must not produce NaN, which would write `opacity: NaN` into the page and leave
    // the ring invisible with no error to explain it.
    expect(Number.isNaN(sampleHighlight(hold(1000, null, 0), 1000))).toBe(false);
    // Still transparent on the very first frame, fully opaque on the next: instant, not broken.
    expect(sampleHighlight(hold(1000, null, 0), 1000)).toBe(0);
    expect(sampleHighlight(hold(1000, null, 0), 1001)).toBe(1);
  });
});
