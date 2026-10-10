/**
 * Viewport presets and resolution maths.
 *
 * A video's shape is its most consequential single decision: a 1080x1920 canvas and a
 * 1920x1080 canvas are not two sizes of the same thing, they are two different products —
 * one is a Reels/TikTok/Shorts asset, the other is a landing-page demo. So the viewport is
 * expressed in three interchangeable ways, all of which resolve to the same concrete numbers:
 *
 * ```ts
 * { viewport: 'vertical' }                          // 1080x1920, 9:16
 * { viewport: { width: 1080, height: 1920 } }       // explicit
 * { viewport: { aspectRatio: '9:16', width: 1080 } } // derived
 * ```
 *
 * ### Why layoutScale exists
 *
 * The page is *laid out* at `output / layoutScale` CSS pixels and the encoder enlarges back to
 * `output`. This is inherited from the reference implementation, where the reasoning was
 * legibility rather than speed: laying out a dashboard at 1080 CSS px makes body text roughly
 * 1.3% of frame width, which is technically correct and practically unreadable on a phone.
 * A secondary benefit is that narrow layouts trigger the app's own responsive breakpoints.
 *
 * The audit later measured a performance benefit too: capture is resolution-independent but
 * encoding is not, so halving the captured area is worth 1.2-1.9x end to end.
 */

/** Pixel dimensions of the output frame. */
export interface Size {
  width: number;
  height: number;
}

/** `width / height`. */
export type AspectRatio = number;

/**
 * Named output shapes.
 *
 * Dimensions are chosen so that `output / layoutScale` is a whole number for the default
 * `layoutScale` of 2 — otherwise the CSS layout is a fractional size and text rasterises at a
 * sub-pixel scale, which softens every glyph in the video.
 */
export const VIEWPORT_PRESETS = {
  /** 9:16 — Instagram Reels, TikTok, YouTube Shorts. The default. */
  vertical: { width: 1080, height: 1920 },
  /** 4:5 — Instagram feed portrait. Taller than wide, less extreme than 9:16. */
  portrait: { width: 1080, height: 1350 },
  /** 1:1 — square feed posts. */
  square: { width: 1080, height: 1080 },
  /** 16:9 — conventional widescreen, the YouTube default. */
  landscape: { width: 1920, height: 1080 },
} as const satisfies Record<string, Size>;

/** Name of a built-in shape. */
export type ViewportPreset = keyof typeof VIEWPORT_PRESETS;

/** Every built-in shape, for error messages and CLI completion. */
export const VIEWPORT_PRESET_NAMES = Object.keys(VIEWPORT_PRESETS) as ViewportPreset[];

/**
 * How the caller may express a shape.
 *
 * `'1080x1920'` strings are accepted as well as the structured forms, because the CLI, the
 * declarative format (§16) and `.env` files all carry viewports as text and parsing them twice
 * would be silly.
 */
export type ViewportInput =
  | ViewportPreset
  | Size
  | { aspectRatio: `${number}:${number}` | number; width?: number; height?: number }
  | string;

/** A resolved, validated shape. */
export interface ResolvedViewport {
  /** Output frame size, in pixels. */
  output: Size;
  /** CSS layout size, in pixels. `output / layoutScale`. */
  layout: Size;
  /** How much larger everything appears than it would at 1:1. */
  scale: number;
  /** `output.width / output.height`, recorded in the manifest. */
  aspectRatio: AspectRatio;
  /** Which preset produced this, or null for a custom shape. */
  preset: ViewportPreset | null;
}

/** Parses a `"WIDTHxHEIGHT"` or `"WIDTH:HEIGHT"` string. Returns null when unparseable. */
function parseDimensionPair(value: string): Size | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*[x×:]\s*(\d+(?:\.\d+)?)\s*$/i.exec(value);
  if (!match) return null;

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return { width, height };
}

/**
 * Resolve a caller-supplied viewport to concrete dimensions.
 *
 * @throws {VideoConfigError} if the shape cannot be understood, is not positive, or violates
 *   the even-dimension constraint that H.264 with `yuv420p` imposes.
 */
export function resolveViewport(input: ViewportInput, layoutScale: number): ResolvedViewport {
  const source = describeViewportInput(input);

  if (typeof input === 'string') {
    if (isPresetName(input)) {
      return finish(VIEWPORT_PRESETS[input], layoutScale, input, source);
    }

    const parsed = parseDimensionPair(input);
    if (!parsed) {
      throw new VideoConfigError(
        `viewport ${JSON.stringify(input)} is not a known preset or a WIDTHxHEIGHT pair. ` +
          `Known presets: ${VIEWPORT_PRESET_NAMES.join(', ')}.`,
        'Use a preset name, or a string like "1080x1920".',
      );
    }
    return finish(parsed, layoutScale, null, source);
  }

  if (
    'width' in input &&
    'height' in input &&
    input.width !== undefined &&
    input.height !== undefined
  ) {
    return finish({ width: input.width, height: input.height }, layoutScale, null, source);
  }

  if ('aspectRatio' in input) {
    return finish(fromAspectRatio(input, source), layoutScale, null, source);
  }

  throw new VideoConfigError(
    `viewport ${source} does not specify a shape.`,
    'Pass a preset name, { width, height }, or { aspectRatio, width } / { aspectRatio, height }.',
  );
}

function isPresetName(value: string): value is ViewportPreset {
  return Object.hasOwn(VIEWPORT_PRESETS, value);
}

/** Render an arbitrary input as something safe to embed in an error message. */
function describeViewportInput(input: unknown): string {
  try {
    return JSON.stringify(input) ?? String(input);
  } catch {
    // Circular structures cannot arise from the declared types, but an error message must never
    // be the thing that throws.
    return String(input);
  }
}

/**
 * Resolve a partial shape that only gives an aspect ratio.
 *
 * One of width or height is required — an aspect ratio alone does not determine a size. The
 * missing side is derived, then both sides are evenised below.
 */
function fromAspectRatio(
  input: { aspectRatio: `${number}:${number}` | number; width?: number; height?: number },
  source: string,
): Size {
  const ratio =
    typeof input.aspectRatio === 'number'
      ? input.aspectRatio
      : (() => {
          const match = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(input.aspectRatio);
          if (!match) {
            throw new VideoConfigError(
              `viewport aspectRatio ${JSON.stringify(input.aspectRatio)} is not "W:H" or a number.`,
              'Example: { aspectRatio: "9:16", width: 1080 }.',
            );
          }
          const numerator = Number(match[1]);
          const denominator = Number(match[2]);
          if (denominator === 0) {
            throw new VideoConfigError(
              `viewport aspectRatio ${JSON.stringify(input.aspectRatio)} has a zero denominator.`,
            );
          }
          return numerator / denominator;
        })();

  if (!Number.isFinite(ratio) || ratio <= 0) {
    throw new VideoConfigError(
      `viewport aspectRatio ${JSON.stringify(input.aspectRatio)} must be a positive number.`,
      source,
    );
  }

  const { width, height } = input;
  if (width !== undefined && height !== undefined) {
    return { width, height };
  }
  if (width !== undefined) return { width, height: width / ratio };
  if (height !== undefined) return { width: height * ratio, height };

  throw new VideoConfigError(
    `viewport ${source} gives an aspect ratio but no size.`,
    'An aspect ratio alone does not determine a frame. Add `width` or `height`.',
  );
}

/**
 * Validate and evenise, then derive the layout size.
 *
 * The even-dimension rule applies to the **output** only. The layout size is a CSS viewport that
 * exists purely so the page lays out at a legible scale; it is captured at that size and scaled
 * to `output` by the encoder, and ffmpeg's `scale` filter has no trouble with an odd input. An
 * odd layout is therefore harmless, and rejecting it would wrongly exclude real shapes — 1080x1350
 * at scale 2 lays out at 540x675, which is the standard 4:5 feed ratio.
 *
 * The layout *must* divide evenly, though. A fractional layout such as 1000/3 = 333.33 would
 * either round and distort the aspect ratio, or leave the page on a fractional pixel grid where
 * every glyph rasterises softened.
 */
function finish(
  size: Size,
  layoutScale: number,
  preset: ViewportPreset | null,
  source: string,
): ResolvedViewport {
  const { width, height } = requireUsableSize(size, source);
  const output = {
    width: requireEven(width, 'width', source),
    height: requireEven(height, 'height', source),
  };

  const layout = {
    width: requireDivisible(output.width, layoutScale, 'width', source, layoutScale),
    height: requireDivisible(output.height, layoutScale, 'height', source, layoutScale),
  };

  return {
    output,
    layout,
    scale: layoutScale,
    aspectRatio: output.width / output.height,
    preset,
  };
}

function requireUsableSize(size: Size, source: string): Size {
  for (const [axis, value] of [
    ['width', size.width],
    ['height', size.height],
  ] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new VideoConfigError(
        `viewport ${source} has an invalid ${axis}: ${String(value)}.`,
        'Dimensions must be positive, finite numbers.',
      );
    }
  }
  return size;
}

/** Reject an odd dimension, explaining the encoder constraint that forbids it. */
function requireEven(value: number, label: string, source: string): number {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded) || rounded < 2) {
    throw new VideoConfigError(
      `viewport ${source} resolves to ${label} of ${value}, which is too small to encode. ` +
        'H.264 with yuv420p requires even dimensions of at least 2px.',
    );
  }
  const even = rounded - (rounded % 2);
  if (even !== rounded) {
    // The reason lives in the message, not only in the hint: a caller that logs just
    // `error.message` must not lose the one fact that explains the failure.
    throw new VideoConfigError(
      `viewport ${source} resolves to an odd ${label} of ${rounded}, which cannot be encoded: ` +
        'H.264 with yuv420p subsamples chroma 2x2, so width and height must both be even.',
      `Use ${even + 2} instead of ${rounded}, or choose one of: ${VIEWPORT_PRESET_NAMES.join(', ')}.`,
    );
  }
  return even;
}

/**
 * Require that a dimension divides evenly by `layoutScale`, returning the layout size.
 *
 * A fractional layout would put the page on a sub-pixel grid, softening every glyph in the
 * video, and would make the encoded aspect ratio differ from the requested one.
 */
function requireDivisible(
  value: number,
  divisor: number,
  label: string,
  source: string,
  layoutScale: number,
): number {
  const layout = value / divisor;
  if (!Number.isInteger(layout) || layout < 2) {
    throw new VideoConfigError(
      `viewport ${source} does not divide evenly by layoutScale ${layoutScale}: ` +
        `${label} ${value} would lay out at ${layout} CSS pixels, which is not a whole number.`,
      `Pick a layoutScale that divides ${value}, or use dimensions it divides evenly.`,
    );
  }
  return layout;
}

/** Thrown for any configuration the framework cannot honour. */
export class VideoConfigError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'VideoConfigError';
  }
}
