/**
 * Easing curves.
 *
 * An easing function maps normalised progress `t` in [0, 1] to eased progress, and is the
 * difference between motion that looks like a cursor and motion that looks like a teleport with
 * steps. Every function here satisfies three invariants, all of which are asserted in the unit
 * suite:
 *
 *   f(0) = 0    motion starts exactly where it was
 *   f(1) = 1    motion ends exactly where it was asked to
 *   f is monotonic non-decreasing    motion never reverses
 *
 * The third is what makes a "natural" cursor path readable. An ease that overshoots backwards
 * reads as a glitch, not as personality.
 *
 * All curves are pure and allocation-free: they are evaluated once per frame, for every animated
 * property, for every frame of the video.
 */

/** A curve from normalised progress to eased progress. */
export type Easing = (t: number) => number;

/** Clamp to [0, 1], normalising negative zero. `Math.max(0, -0)` is `0`. */
function clamp01(t: number): number {
  if (Number.isNaN(t)) return 0;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** No easing. For `behavior: 'instant'`, and for linear loaders and progress bars. */
export const linear: Easing = (t) => clamp01(t);

/**
 * Accelerate then decelerate.
 *
 * The default for cursor movement and scrolling. Starts slow, peaks at the midpoint, settles
 * gently — which is the shape a human hand actually produces.
 */
export const easeInOutCubic: Easing = (t) => {
  const p = clamp01(t);
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
};

/**
 * Decelerate only.
 *
 * Fast out of the gate, easing into the target. Correct when something has already been
 * happening and is merely arriving — a scroll finishing, a settle.
 */
export const easeOutCubic: Easing = (t) => 1 - Math.pow(1 - clamp01(t), 3);

/** Accelerate only. For something leaving a resting state and still accelerating. */
export const easeInCubic: Easing = (t) => clamp01(t) ** 3;

/**
 * Decelerate hard, then a brief settle.
 *
 * Slightly more character than easeOutCubic: the tail is slower, which reads as weight. Used for
 * scroll settling where a linear tail looks mechanical.
 */
export const easeOutQuart: Easing = (t) => 1 - Math.pow(1 - clamp01(t), 4);

/**
 * A single overshoot past the target, then return.
 *
 * Deliberately *not* used for cursor movement — see the note on overshoot in `overshoot.ts`.
 * Offered for scroll and camera moves where a hint of momentum reads well.
 *
 * The peak is held briefly rather than touched instantly, because a curve that peaks and
 * returns within one frame is indistinguishable from no overshoot at all.
 */
export const easeOutBack: Easing = (t) => {
  const p = clamp01(t);
  // 1.70158 overshoots by ~10%; c3 = c1 + 1 puts the return exactly back on 1.
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
};

/**
 * A gentle two-stage motion: accelerate, brief plateau, decelerate.
 *
 * For longer travel where a single smooth arc reads as too simple.
 */
export const easeInOutSine: Easing = (t) => (1 - Math.cos(Math.PI * clamp01(t))) / 2;

/** Every named curve, by name. */
export const EASINGS = {
  linear,
  easeInCubic,
  easeOutCubic,
  easeOutQuart,
  easeInOutCubic,
  easeInOutSine,
  easeOutBack,
} as const satisfies Record<string, Easing>;

/** Name of a built-in curve. */
export type EasingName = keyof typeof EASINGS;

/**
 * Resolve a curve by name.
 *
 * @throws {RangeError} for an unknown name, listing the alternatives — a typo in a YAML video
 *   definition should fail with the valid options, not with `undefined is not a function`.
 */
export function easingByName(name: EasingName | string): Easing {
  if (typeof name === 'string' && Object.hasOwn(EASINGS, name)) {
    return EASINGS[name as EasingName];
  }
  throw new RangeError(
    `Unknown easing "${String(name)}". Available: ${Object.keys(EASINGS).join(', ')}.`,
  );
}
