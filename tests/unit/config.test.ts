import { describe, expect, it } from 'vitest';

import {
  framesFor,
  resolveConfig,
  resolveViewport,
  timeForFrame,
  VIEWPORT_PRESETS,
  VIEWPORT_PRESET_NAMES,
  VideoConfigError,
} from '../../src/config/config.js';

describe('viewport presets', () => {
  it('exposes the shapes a product video actually needs', () => {
    expect(VIEWPORT_PRESET_NAMES).toEqual(['vertical', 'portrait', 'square', 'landscape']);
  });

  it('describes each preset with the ratio its name implies', () => {
    expect(VIEWPORT_PRESETS.vertical).toEqual({ width: 1080, height: 1920 });
    expect(VIEWPORT_PRESETS.vertical.width / VIEWPORT_PRESETS.vertical.height).toBeCloseTo(
      9 / 16,
      3,
    );
    expect(VIEWPORT_PRESETS.landscape.width / VIEWPORT_PRESETS.landscape.height).toBeCloseTo(
      16 / 9,
      3,
    );
    expect(VIEWPORT_PRESETS.square.width).toBe(VIEWPORT_PRESETS.square.height);
  });

  it('divides every preset evenly by the default layoutScale of 2', () => {
    // A fractional layout size rasterises text at a sub-pixel scale and softens every glyph.
    for (const name of VIEWPORT_PRESET_NAMES) {
      const viewport = resolveViewport(name, 2);
      expect(Number.isInteger(viewport.layout.width)).toBe(true);
      expect(Number.isInteger(viewport.layout.height)).toBe(true);
      expect(viewport.layout.width).toBeGreaterThanOrEqual(2);
      expect(viewport.layout.height).toBeGreaterThanOrEqual(2);
    }
  });

  it('resolves every preset at the default layoutScale', () => {
    // Regression: 1080x1350 is the standard 4:5 feed ratio and lays out at 540x675. An earlier
    // version of this validator required *even* layout dimensions too, which silently excluded
    // the portrait preset — even-ness is only an encoder requirement on the output.
    for (const name of VIEWPORT_PRESET_NAMES) {
      expect(() => resolveViewport(name, 2)).not.toThrow();
    }

    expect(resolveViewport('portrait', 2).layout).toEqual({ width: 540, height: 675 });
  });

  it('defaults to vertical when no viewport is given', () => {
    expect(resolveConfig().viewport.output).toEqual({ width: 1080, height: 1920 });
    expect(resolveConfig().viewport.preset).toBe('vertical');
  });
});

describe('resolveViewport input forms', () => {
  it('accepts a preset name', () => {
    const viewport = resolveViewport('landscape', 2);
    expect(viewport.output).toEqual({ width: 1920, height: 1080 });
    expect(viewport.layout).toEqual({ width: 960, height: 540 });
    expect(viewport.preset).toBe('landscape');
  });

  it('accepts an explicit size', () => {
    const viewport = resolveViewport({ width: 1080, height: 1920 }, 2);
    expect(viewport.output).toEqual({ width: 1080, height: 1920 });
    expect(viewport.layout).toEqual({ width: 540, height: 960 });
    expect(viewport.preset).toBeNull();
  });

  it('accepts a "WIDTHxHEIGHT" string', () => {
    expect(resolveViewport('1080x1920', 2).output).toEqual({ width: 1080, height: 1920 });
  });

  it('accepts a "WIDTHxHEIGHT" string using a multiplication sign', () => {
    expect(resolveViewport('1080×1920', 2).output).toEqual({ width: 1080, height: 1920 });
  });

  it('accepts a colon-separated string', () => {
    expect(resolveViewport('1920:1080', 2).output).toEqual({ width: 1920, height: 1080 });
  });

  it('derives height from an aspect ratio and a width', () => {
    const viewport = resolveViewport({ aspectRatio: '9:16', width: 1080 }, 2);
    expect(viewport.output).toEqual({ width: 1080, height: 1920 });
  });

  it('derives width from an aspect ratio and a height', () => {
    const viewport = resolveViewport({ aspectRatio: '16:9', height: 1080 }, 2);
    expect(viewport.output).toEqual({ width: 1920, height: 1080 });
  });

  it('accepts a numeric aspect ratio', () => {
    const viewport = resolveViewport({ aspectRatio: 1, height: 1080 }, 2);
    expect(viewport.output).toEqual({ width: 1080, height: 1080 });
  });

  it('reports the resolved aspect ratio', () => {
    expect(resolveViewport('vertical', 2).aspectRatio).toBeCloseTo(9 / 16, 6);
  });
});

describe('resolveViewport — layout scaling', () => {
  it('defaults to scaling down by 2', () => {
    const viewport = resolveViewport('vertical', 2);
    expect(viewport.layout).toEqual({ width: 540, height: 960 });
    expect(viewport.scale).toBe(2);
  });

  it('supports 1:1 layout', () => {
    // At scale 1 a dense dashboard renders text at ~1.3% of frame width. Supported, but the
    // reason 2 exists.
    const viewport = resolveViewport('vertical', 1);
    expect(viewport.layout).toEqual({ width: 1080, height: 1920 });
  });

  it('accepts an odd layout size, because only the output is encoded', () => {
    // 4:5 at scale 2 lays out at 540x675. ffmpeg's scale filter has no trouble with an odd
    // input; only the encoded output must be even.
    expect(resolveViewport({ aspectRatio: '4:5', width: 1080 }, 2)).toMatchObject({
      output: { width: 1080, height: 1350 },
      layout: { width: 540, height: 675 },
    });
  });

  it('rejects a layoutScale that does not divide the output evenly', () => {
    // 1000x1000 at scale 3 is 333.33 CSS px — a sub-pixel grid, and a distorted aspect ratio.
    expect(() => resolveViewport({ width: 1000, height: 1000 }, 3)).toThrow(VideoConfigError);
  });

  it('rejects a scale that would collapse a layout dimension below 2px', () => {
    expect(() => resolveViewport({ width: 4, height: 4 }, 4)).toThrow(VideoConfigError);
  });
});

describe('resolveViewport — even-dimension enforcement', () => {
  it('explains why an odd dimension cannot be encoded', () => {
    let thrown: unknown;
    try {
      resolveViewport({ width: 1081, height: 1920 }, 1);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(VideoConfigError);
    // The message must name the offending value and the reason, so that a caller logging only
    // `error.message` still learns what went wrong. ffmpeg's own failure for this case is
    // "width not divisible by 2", which costs a debugging session to connect back to config.
    expect((thrown as Error).message).toContain('1081');
    expect((thrown as Error).message).toContain('yuv420p');
    // The concrete fix belongs in the hint, where the CLI prints it alongside the message.
    expect((thrown as VideoConfigError).hint).toContain('1082');
  });

  it('rejects an odd height', () => {
    expect(() => resolveViewport({ width: 1080, height: 1921 }, 1)).toThrow(VideoConfigError);
  });
});

describe('resolveViewport — rejected input', () => {
  it('names the available presets when the name is unknown', () => {
    let thrown: unknown;
    try {
      resolveViewport('cinemascope', 2);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toContain('vertical');
    expect((thrown as Error).message).toContain('landscape');
  });

  it('rejects a zero or negative dimension', () => {
    expect(() => resolveViewport({ width: 0, height: 1920 }, 1)).toThrow(VideoConfigError);
    expect(() => resolveViewport({ width: -1080, height: 1920 }, 1)).toThrow(VideoConfigError);
  });

  it('rejects a non-finite dimension', () => {
    expect(() => resolveViewport({ width: Number.NaN, height: 1920 }, 1)).toThrow(VideoConfigError);
    expect(() => resolveViewport({ width: 1080, height: Number.POSITIVE_INFINITY }, 1)).toThrow(
      VideoConfigError,
    );
  });

  it('rejects an aspect ratio with no size', () => {
    // A ratio alone does not determine a frame.
    let thrown: unknown;
    try {
      resolveViewport({ aspectRatio: '9:16' }, 2);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toContain('aspect ratio');
  });

  it('rejects a malformed aspect ratio', () => {
    expect(() => resolveViewport({ aspectRatio: 'wide', width: 1080 } as never, 2)).toThrow(
      VideoConfigError,
    );
    expect(() => resolveViewport({ aspectRatio: '9:0', width: 1080 }, 2)).toThrow(VideoConfigError);
    expect(() => resolveViewport({ aspectRatio: -1, width: 1080 }, 2)).toThrow(VideoConfigError);
  });

  it('rejects an empty shape object', () => {
    expect(() => resolveViewport({} as never, 2)).toThrow(VideoConfigError);
  });
});

describe('resolveConfig defaults', () => {
  it('produces a usable config from no arguments at all', () => {
    const config = resolveConfig();

    expect(config.fps).toBe(30);
    expect(config.layoutScale).toBe(2);
    expect(config.viewport.output).toEqual({ width: 1080, height: 1920 });
    expect(config.recorder.backend).toBe('frames');
    expect(config.cursor.mode).toBe('overlay');
    expect(config.browser.headless).toBe(true);
  });

  it('records everything a manifest needs to reproduce the run', () => {
    const config = resolveConfig({ seed: 42069, fps: 60, viewport: 'landscape' });

    expect(config.seed).toBe(42069);
    expect(config.fps).toBe(60);
    expect(config.viewport.output).toEqual({ width: 1920, height: 1080 });
  });

  it('merges partial sub-objects over the defaults', () => {
    const config = resolveConfig({ browser: { headless: false } });

    expect(config.browser.headless).toBe(false);
    expect(config.browser.colorScheme).toBe('dark');
    expect(config.browser.reducedMotion).toBe('reduce');
  });

  it('defaults storageState and executablePath to undefined rather than an empty string', () => {
    const config = resolveConfig();
    expect(config.browser.storageState).toBeUndefined();
    expect(config.browser.executablePath).toBeUndefined();
  });
});

describe('resolveConfig — validation', () => {
  it('rejects a non-integer fps and states the permitted range', () => {
    let thrown: unknown;
    try {
      resolveConfig({ fps: 0 });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toContain('fps');
    expect((thrown as Error).message).toContain('between 1 and 240');
  });

  it('rejects a fractional fps', () => {
    expect(() => resolveConfig({ fps: 29.97 })).toThrow(VideoConfigError);
  });

  it('rejects a layoutScale outside 1-4', () => {
    expect(() => resolveConfig({ layoutScale: 0 })).toThrow(VideoConfigError);
    expect(() => resolveConfig({ layoutScale: 5 })).toThrow(VideoConfigError);
  });

  it('rejects an out-of-range CRF', () => {
    expect(() => resolveConfig({ recorder: { crf: 52 } })).toThrow(VideoConfigError);
    expect(() => resolveConfig({ recorder: { crf: -1 } })).toThrow(VideoConfigError);
  });

  it('rejects an out-of-range frame quality', () => {
    expect(() => resolveConfig({ recorder: { frameQuality: 0 } })).toThrow(VideoConfigError);
    expect(() => resolveConfig({ recorder: { frameQuality: 101 } })).toThrow(VideoConfigError);
  });

  it('rejects an unknown backend or cursor mode and lists the alternatives', () => {
    let thrown: unknown;
    try {
      resolveConfig({ recorder: { backend: 'avi' as never } });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toContain('"frames"');
    expect((thrown as Error).message).toContain('"screencast"');

    expect(() => resolveConfig({ cursor: { mode: 'system' as never } })).toThrow(VideoConfigError);
  });

  it('rejects a negative pacing delay', () => {
    // A negative pause would move logical time backwards, corrupting every frame index after it.
    expect(() => resolveConfig({ timing: { short: -1 } })).toThrow(VideoConfigError);
  });

  it('rejects an empty output path', () => {
    expect(() => resolveConfig({ output: '   ' })).toThrow(VideoConfigError);
  });

  it('rejects non-string entries in args and extraCss', () => {
    expect(() => resolveConfig({ browser: { args: [1 as never] } })).toThrow(VideoConfigError);
    expect(() => resolveConfig({ browser: { extraCss: [null as never] } })).toThrow(
      VideoConfigError,
    );
  });

  it('distinguishes an explicit null from an omitted value', () => {
    // For colorScheme and reducedMotion, null means "leave the browser default alone". Using
    // `??` cannot tell that apart from "not provided", so null silently kept the default.
    expect(resolveConfig({ browser: { reducedMotion: null } }).browser.reducedMotion).toBeNull();
    expect(resolveConfig({ browser: { colorScheme: null } }).browser.colorScheme).toBeNull();
    // Omitting them still gets the defaults.
    expect(resolveConfig({}).browser.reducedMotion).toBe('reduce');
    expect(resolveConfig({}).browser.colorScheme).toBe('dark');
  });

  it('copies arrays so later mutation of the caller object cannot alter config', () => {
    const args = ['--mute-audio'];
    const config = resolveConfig({ browser: { args } });
    args.push('--disable-gpu');

    expect(config.browser.args).toEqual(['--mute-audio']);
  });
});

describe('frame maths', () => {
  it('converts a duration to a frame count', () => {
    expect(framesFor(1000, 30)).toBe(30);
    expect(framesFor(1000, 60)).toBe(60);
    expect(framesFor(500, 30)).toBe(15);
  });

  it('never returns fewer than one frame', () => {
    // A zero-frame video is invalid; a one-frame video is a still image and is legal.
    expect(framesFor(0, 30)).toBe(1);
    expect(framesFor(1, 30)).toBe(1);
  });

  it('maps frame indices to logical timestamps', () => {
    expect(timeForFrame(0, 30)).toBe(0);
    expect(timeForFrame(30, 30)).toBe(1000);
    expect(timeForFrame(60, 60)).toBe(1000);
  });

  it('round-trips a frame boundary to its frame count', () => {
    // The timestamp at which frame n+1 begins is the end of n frames, so framesFor at that
    // timestamp must be exactly n+1 — not n+2. This also guards the floating-point division
    // inside both helpers against drifting at non-integer fps values.
    for (const fps of [24, 30, 60]) {
      for (const frame of [0, 1, 17, 300]) {
        expect(framesFor(timeForFrame(frame + 1, fps), fps)).toBe(frame + 1);
      }
    }
  });
});
