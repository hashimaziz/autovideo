/**
 * Interpolation.
 *
 * With the frame-pump architecture, an animation is never "run". It is *sampled*: given a logical
 * timestamp, the track must produce the exact state at that instant. So interpolation is not a
 * detail here, it is the core primitive — and it must be a pure function of `(t)`, with no
 * dependence on how many times it has been called or when.
 *
 * That purity is what makes a render reproducible. An alternative design advances a value frame
 * by frame (`value += delta`); it accumulates floating-point error, and a dropped frame changes
 * every subsequent value. Sampling from the start position every time has neither problem.
 */

import { linear, type Easing } from './easing.js';

/** A point in 2D space, in CSS pixels relative to the viewport. */
export interface Point {
  x: number;
  y: number;
}

/**
 * Interpolate a single number.
 *
 * @param t Normalised progress, clamped to [0, 1] so an out-of-range timestamp can never
 *   produce motion outside the declared path.
 */
export function lerp(from: number, to: number, t: number, easing: Easing = linear): number {
  return from + (to - from) * easing(t);
}

/**
 * Interpolate a point.
 *
 * Straight-line by default. Cursor paths add curvature separately, because a curve through two
 * points needs a control point and that is a motion decision, not an interpolation one.
 */
export function lerpPoint(from: Point, to: Point, t: number, easing: Easing = linear): Point {
  return { x: lerp(from.x, to.x, t, easing), y: lerp(from.y, to.y, t, easing) };
}

/**
 * Progress of an animation at a given logical time.
 *
 * @param startMs    Logical time the animation begins.
 * @param durationMs Length of the animation. Zero means the animation is already over.
 * @param atMs       Current logical time.
 * @returns Progress in [0, 1]. Before the start: 0. After the end: 1.
 */
export function progressAt(startMs: number, durationMs: number, atMs: number): number {
  if (durationMs <= 0) return 1;
  if (atMs <= startMs) return 0;
  const elapsed = atMs - startMs;
  return elapsed >= durationMs ? 1 : elapsed / durationMs;
}

/**
 * Evaluate an animation's value at a logical time.
 *
 * `sample(startMs, durationMs, atMs, (t) => ...)` — the callback receives eased progress and
 * returns the state. Used by every animated property so they all share one timing model.
 */
export function sampleAt<T>(
  startMs: number,
  durationMs: number,
  atMs: number,
  sample: (t: number) => T,
  easing: Easing = linear,
): T {
  return sample(easing(progressAt(startMs, durationMs, atMs)));
}

/** Euclidean distance between two points. */
export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Distance covered by `value` moved from `from` to `to` over `durationMs`.
 *
 * Used to derive a sensible default duration from a cursor's travel distance, so a short hop is
 * quick and a long sweep across the frame is not.
 */
export function travelDuration(from: Point, to: Point, pixelsPerSecond = 900): number {
  return (distance(from, to) / pixelsPerSecond) * 1000;
}

/**
 * Clamp a value into a range.
 *
 * Scroll targets need this constantly: a page has a maximum scroll offset, and asking for more
 * than exists must land on the end of the document rather than overshooting into nothing.
 */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
