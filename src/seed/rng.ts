/**
 * Deterministic pseudo-randomness.
 *
 * The plan forbids `Math.random()` anywhere in the framework (§19). Everything that looks
 * spontaneous — cursor path curvature, inter-key typing delays, the occasional pause between
 * typing bursts — must instead draw from a generator seeded by the video's `seed`, so that:
 *
 *   same seed + same script + same app  =>  same video
 *
 * ### Why streams, not one shared generator
 *
 * A single shared generator has a fragile property: adding one extra `float()` call anywhere
 * shifts every subsequent draw, so a harmless-looking change to one action silently changes the
 * motion of every action after it. Reproducibility then holds only for a given build, not across
 * the framework's own history — which defeats the point.
 *
 * Named streams fix this. Each consumer (`cursor`, `typing`, `scroll`, …) draws from its own
 * generator, derived from the seed and the stream name. Adding draws to one stream cannot
 * perturb another, so videos stay stable as the framework grows.
 *
 * ### Generator choice
 *
 * `sfc32` — a small, fast, well-tested 32-bit counter-based generator with a 2^128 period.
 * Chosen over `Math.random()` (unseedable) and over a cryptographic generator (slower, and the
 * statistical strength is irrelevant for motion jitter).
 */

/** Largest value a 32-bit unsigned integer can hold; used to scale raw words to [0, 1). */
const UINT32_RANGE = 4294967296;

/** FNV-1a prime. Standard for cheap, well-distributed string hashing. */
const FNV_PRIME = 16777619;

/** `Math.imul` keeps 32-bit multiplication exact; `*` loses precision above 2^53. */
function imul(a: number, b: number): number {
  return Math.imul(a, b);
}

/**
 * FNV-1a over a string, returning a 32-bit unsigned integer.
 *
 * Used to turn a stream name into a seed offset. Any well-distributed hash would do; FNV-1a is
 * chosen because it is short enough to read and its avalanche behaviour on short ASCII keys is
 * adequate for seeding rather than for security.
 */
export function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/**
 * SplitMix32 — used only to expand one seed integer into four words of generator state.
 *
 * Seeding `sfc32` directly from a small seed produces visibly correlated output across nearby
 * seeds (seeds 1 and 2 give nearly identical first draws). Running the seed through SplitMix32
 * first decorrelates them.
 */
function splitmix32(initial: number): () => number {
  let state = initial | 0;
  return () => {
    state = (state + 0x9e3779b9) | 0;
    let mixed = state ^ (state >>> 16);
    mixed = imul(mixed, 0x21f0aaad);
    mixed ^= mixed >>> 15;
    mixed = imul(mixed, 0x735a2d97);
    mixed ^= mixed >>> 15;
    return mixed >>> 0;
  };
}

/** The raw generator: four 32-bit words of state, one 32-bit output per call. */
function sfc32(a: number, b: number, c: number, d: number): () => number {
  let s0 = a | 0;
  let s1 = b | 0;
  let s2 = c | 0;
  let s3 = d | 0;

  return () => {
    const result = (((s0 + s1) | 0) + s3) | 0;
    s3 = (s3 + 1) | 0;
    s0 = s1 ^ (s1 >>> 9);
    s1 = (s2 + imul(s2, 8)) | 0; // (s2 << 3) | 0, without the int32 sign confusion
    s2 = (s2 << 21) | (s2 >>> 11);
    s2 = (s2 + result) | 0;
    return (result >>> 0) / UINT32_RANGE;
  };
}

/** Build an `sfc32` generator from a seed and an optional stream discriminator. */
function buildGenerator(seed: number, streamName?: string): () => number {
  const offset = streamName === undefined ? 0 : hashString(streamName);
  const expand = splitmix32(seed ^ imul(offset, FNV_PRIME));

  const generator = sfc32(expand(), expand(), expand(), expand());

  // Discard the first draws. A freshly seeded generator is still warming up, and the earliest
  // outputs of sfc32 from a SplitMix32-expanded state are the weakest. The cost is four calls.
  generator();
  generator();
  generator();
  generator();

  return generator;
}

/** Public surface of a seeded generator. */
export interface Rng {
  /** The seed this generator (and all of its streams) derives from. */
  readonly seed: number;

  /** Uniform float in [0, 1). */
  float(): number;

  /** Uniform integer in [minInclusive, maxExclusive). Reversed bounds throw. */
  int(minInclusive: number, maxExclusive: number): number;

  /** Uniform integer in [min, max], both ends inclusive. */
  intInclusive(min: number, max: number): number;

  /** True with the given probability (default 0.5). */
  boolean(probability?: number): boolean;

  /** Uniform float in [min, max). */
  between(min: number, max: number): number;

  /** One element, chosen uniformly. Throws on an empty list. */
  pick<T>(items: readonly T[]): T;

  /**
   * `count` distinct elements, in a random order. The result is a new array; the input is not
   * modified. Throws if `count` exceeds the input length.
   */
  sample<T>(items: readonly T[], count: number): T[];

  /** A shuffled copy. The input is not modified. */
  shuffle<T>(items: readonly T[]): T[];

  /** Normally-distributed float via the Box-Muller transform. */
  gaussian(mean?: number, standardDeviation?: number): number;

  /**
   * An independent generator for a named consumer.
   *
   * Streams derived from the same seed and name are identical across runs, and unaffected by
   * how many values any other stream has drawn.
   */
  stream(name: string): Rng;
}

/** Human-readable label for the failure cases below; keeps messages actionable. */
function requireNonEmpty<T>(items: readonly T[], method: string): void {
  if (items.length === 0) {
    throw new RangeError(`rng.${method}() was called with an empty array.`);
  }
}

/**
 * A seeded pseudo-random generator.
 *
 * Prefer {@link createRng} over constructing this directly — it validates the seed.
 */
export class SeededRng implements Rng {
  readonly seed: number;

  readonly #next: () => number;

  /** Cached spare value from the Box-Muller pair, which yields two normals per two uniforms. */
  #gaussianSpare: number | undefined;

  /**
   * @param seed        The video's seed. Recorded on the generator so manifests can report it.
   * @param streamName  Optional discriminator. Present on streams, absent on the root generator.
   */
  constructor(seed: number, streamName?: string) {
    this.seed = seed;
    this.#next = buildGenerator(seed, streamName);
  }

  float(): number {
    return this.#next();
  }

  /**
   * Uniform integer via rejection sampling rather than `Math.floor(float() * range)`.
   *
   * The direct multiplication is biased: the largest outcomes are up to one unit more likely
   * than the smallest. At `range = 6` that is a ~1.7% relative skew. It would never be visible
   * as motion jitter, but "seeded randomness" that is quietly non-uniform is a trap for anyone
   * who later uses it for something that matters, so the unbiased path is the only one offered.
   */
  int(minInclusive: number, maxExclusive: number): number {
    if (!Number.isFinite(minInclusive) || !Number.isFinite(maxExclusive)) {
      throw new RangeError('rng.int() requires finite bounds.');
    }

    const min = Math.ceil(minInclusive);
    const max = Math.ceil(maxExclusive);
    if (max <= min) {
      // Reversed bounds throw rather than being swapped. A call like `int(10, 5)` is far more
      // likely to be an off-by-one in the caller than a genuine intent to invert the range, and
      // silently returning values in a different interval than asked for would hide that.
      throw new RangeError(`rng.int() requires maxExclusive > minInclusive (got ${min}, ${max}).`);
    }

    const range = max - min;

    if (range <= UINT32_RANGE) {
      // Largest multiple of `range` representable in 32 bits. Anything at or above it is
      // rejected rather than folded, which is what removes the bias.
      const limit = UINT32_RANGE - (UINT32_RANGE % range);

      let word: number;
      do {
        word = (this.#next() * UINT32_RANGE) >>> 0;
      } while (word >= limit);

      return min + (word % range);
    }

    // Ranges wider than 2^32 have no 32-bit rejection threshold — computing one would give a
    // limit of 0 and loop forever — so fall back to combining two words into a 53-bit value.
    // The residual modulo bias is below 2^-53 relative, which is far below anything observable.
    const high = (this.#next() * UINT32_RANGE) >>> 0;
    const low = (this.#next() * UINT32_RANGE) >>> 0;
    const wide = high * UINT32_RANGE + low;

    return min + (wide % range);
  }

  intInclusive(min: number, max: number): number {
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      throw new RangeError('rng.intInclusive() requires finite bounds.');
    }
    // Here the swap is safe rather than dangerous: both bounds are meaningful and inclusive, so
    // `intInclusive(3, 1)` is an ordinary way to spell "between 1 and 3".
    if (max < min) return this.intInclusive(max, min);
    return this.int(min, max + 1);
  }

  boolean(probability = 0.5): boolean {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new RangeError(`rng.boolean() requires a probability in [0, 1] (got ${probability}).`);
    }
    return this.#next() < probability;
  }

  between(min: number, max: number): number {
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      throw new RangeError('rng.between() requires finite bounds.');
    }
    return min + this.#next() * (max - min);
  }

  pick<T>(items: readonly T[]): T {
    requireNonEmpty(items, 'pick');
    // `items[index]` is checked: noUncheckedIndexedAccess makes the array access `T | undefined`.
    return items[this.int(0, items.length)] as T;
  }

  sample<T>(items: readonly T[], count: number): T[] {
    requireNonEmpty(items, 'sample');
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError(`rng.sample() requires a non-negative integer count (got ${count}).`);
    }
    if (count > items.length) {
      throw new RangeError(
        `rng.sample() cannot take ${count} items from a list of ${items.length}.`,
      );
    }

    // Fisher-Yates over a copy, then take a prefix. Simple, unbiased, and never leaves duplicate
    // entries the way repeated pick()-with-replacement would.
    const pool = [...items];
    for (let index = 0; index < pool.length; index++) {
      const swapWith = this.int(index, pool.length);
      const held = pool[index] as T;
      pool[index] = pool[swapWith] as T;
      pool[swapWith] = held;
    }
    return pool.slice(0, count);
  }

  shuffle<T>(items: readonly T[]): T[] {
    // Shuffling an empty list is a no-op, not a caller error — unlike pick()/sample(), which
    // genuinely have nothing to return.
    return items.length === 0 ? [] : this.sample(items, items.length);
  }

  gaussian(mean = 0, standardDeviation = 1): number {
    if (!Number.isFinite(mean) || !Number.isFinite(standardDeviation)) {
      throw new RangeError('rng.gaussian() requires finite parameters.');
    }

    if (this.#gaussianSpare !== undefined) {
      const spare = this.#gaussianSpare;
      this.#gaussianSpare = undefined;
      return mean + spare * standardDeviation;
    }

    // Box-Muller. `1 - float()` is used rather than `float()` because `Math.log(0)` is -Infinity,
    // and float() can legitimately return exactly 0.
    const u1 = 1 - this.#next();
    const u2 = this.#next();
    const magnitude = Math.sqrt(-2 * Math.log(u1));
    const angle = 2 * Math.PI * u2;

    this.#gaussianSpare = magnitude * Math.sin(angle);
    return mean + magnitude * Math.cos(angle) * standardDeviation;
  }

  stream(name: string): Rng {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('rng.stream() requires a non-empty name.');
    }
    // A fresh generator derived from (seed, name). It shares no state with this one, so draws
    // here cannot perturb draws there, and vice versa.
    return new SeededRng(this.seed, name);
  }
}

/**
 * Create a seeded generator.
 *
 * ```ts
 * const rng = createRng(42069);
 * rng.float();               // 0.8164...
 * rng.int(0, 60);            // 37
 * rng.stream('typing');     // an independent generator, stable across runs
 * ```
 *
 * @param seed Any finite number. Non-integers are truncated toward zero.
 * @throws {TypeError} if `seed` is not a finite number.
 */
export function createRng(seed: number): SeededRng {
  if (typeof seed !== 'number' || !Number.isFinite(seed)) {
    throw new TypeError(`createRng() requires a finite number seed (got ${String(seed)}).`);
  }
  return new SeededRng(Math.trunc(seed));
}
