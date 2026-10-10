/**
 * The motion track.
 *
 * A track is a set of animations, each sampled by logical time. It exists so that motion is
 * *state*, not *side effects*: at any frame index the track can be asked what the cursor
 * position and scroll offset should be, and it answers without reference to when or how often it
 * was asked.
 *
 * This is what makes the frame pump possible. A real mouse cannot be un-moved, so a
 * screencast-based recorder has to *drive* motion in wall-clock time and hope it is captured at
 * the right moments. Here the pump decides frame 47, asks the track where the cursor is at
 * 1566ms, applies that, and captures. The motion is a pure function of the frame index.
 *
 * ### Resolution order
 *
 * When several animations touch the same property at the same instant, the most recently
 * registered one wins. Actions are sequential, so "most recent" is also "most relevant" — a new
 * cursor move always supersedes an unfinished earlier one rather than fighting it.
 */

import { linear, type Easing } from './easing.js';
import { progressAt, type Point } from './interpolation.js';

/** A named, sampleable value. */
export type Animation<T> = (atMs: number) => T;

/** A zero-duration animation that always yields `value`. */
export function constant<T>(value: T): Animation<T> {
  return () => value;
}

/**
 * Interpolate a scalar over time.
 *
 * @param fromMs Logical start.
 * @param toMs   Logical end. Equal to `fromMs` for an instant change.
 */
export function animateNumber(
  fromMs: number,
  toMs: number,
  from: number,
  to: number,
  easing: Easing = linear,
): Animation<number> {
  return (atMs) => {
    const t = easing(progressAt(fromMs, toMs - fromMs, atMs));
    return from + (to - from) * t;
  };
}

/**
 * Interpolate a point over time, with optional curvature.
 *
 * `bow` controls how far the path bulges perpendicular to the straight line between the points,
 * as a fraction of that distance. Zero is a straight line; the default of 0.08 gives the slight
 * arc a human wrist produces without looking like a thrown object.
 *
 * The direction of the bow is derived from the hash of the endpoints, so a given move always
 * bows the same way. Deriving it from elapsed time would make the path differ frame to frame,
 * which would look like the cursor wobbling.
 */
export function animatePoint(
  fromMs: number,
  toMs: number,
  from: Point,
  to: Point,
  options: { easing?: Easing; bow?: number } = {},
): Animation<Point> {
  const { easing = linear, bow = 0 } = options;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);

  if (length === 0 || bow === 0) {
    return (atMs) => {
      const t = easing(progressAt(fromMs, toMs - fromMs, atMs));
      return { x: from.x + dx * t, y: from.y + dy * t };
    };
  }

  // Perpendicular to the travel direction, scaled by the bow fraction. Fixed sign, chosen
  // deterministically from the endpoints so the same move always curves the same way.
  const side = from.x + to.x + from.y + to.y >= 0 ? 1 : -1;
  const control: Point = {
    x: (from.x + to.x) / 2 - (dy / length) * bow * length * side,
    y: (from.y + to.y) / 2 + (dx / length) * bow * length * side,
  };

  // Quadratic Bézier. Evaluating from `from` every frame rather than advancing incrementally
  // keeps the path exact regardless of frame rate or dropped frames.
  return (atMs) => {
    const t = easing(progressAt(fromMs, toMs - fromMs, atMs));
    const inverse = 1 - t;
    return {
      x: inverse * inverse * from.x + 2 * inverse * t * control.x + t * t * to.x,
      y: inverse * inverse * from.y + 2 * inverse * t * control.y + t * t * to.y,
    };
  };
}

/** The state of everything currently animating. */
export interface MotionState {
  cursor: Point;
  cursorVisible: boolean;
  scrollY: number;
}

/**
 * A set of animations sampled by logical time.
 *
 * One track exists per run. Actions replace individual properties on it; the frame pump reads
 * the whole state each frame.
 */
export class MotionTrack {
  #cursor: Animation<Point> = constant({ x: 0, y: 0 });
  #cursorVisible: Animation<boolean> = constant(false);
  #scrollY: Animation<number> = constant(0);

  /** Replace the cursor path. A new animation supersedes any earlier one immediately. */
  setCursor(animation: Animation<Point>): void {
    this.#cursor = animation;
  }

  /** Replace cursor visibility. */
  setCursorVisible(animation: Animation<boolean>): void {
    this.#cursorVisible = animation;
  }

  /** Replace the scroll offset. */
  setScrollY(animation: Animation<number>): void {
    this.#scrollY = animation;
  }

  /** Sample every property at `atMs`. */
  sample(atMs: number): MotionState {
    return {
      cursor: this.#cursor(atMs),
      cursorVisible: this.#cursorVisible(atMs),
      scrollY: this.#scrollY(atMs),
    };
  }

  /** Sample only the cursor. Cheap enough to call per frame without the rest. */
  sampleCursor(atMs: number): Point {
    return this.#cursor(atMs);
  }

  sampleScrollY(atMs: number): number {
    return this.#scrollY(atMs);
  }

  sampleCursorVisible(atMs: number): boolean {
    return this.#cursorVisible(atMs);
  }
}

/**
 * Whether an animation has finished by `atMs`.
 *
 * Actions await this rather than a wall-clock sleep, which is what lets a `pause` and a cursor
 * move occupy exactly the span of video time the script asked for.
 */
export function isFinished(startMs: number, durationMs: number, atMs: number): boolean {
  return atMs >= startMs + durationMs;
}
