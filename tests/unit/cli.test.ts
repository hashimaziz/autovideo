import { describe, expect, it } from 'vitest';

import { flag, intOption, option, parseArgs, unknownOptions } from '../../src/cli/args.js';
import { createInspectionRecorder } from '../../src/cli/inspect.js';
import { formatChecks } from '../../src/cli/doctor.js';
import { readRunOptions } from '../../src/cli/bin.js';

describe('parseArgs', () => {
  it('separates positionals, options and flags', () => {
    const args = parseArgs(['render', 'demo.ts', '--fps', '60', '--headed']);

    expect(args.positionals).toEqual(['render', 'demo.ts']);
    expect(args.options).toEqual({ fps: '60' });
    expect(args.flags.has('headed')).toBe(true);
  });

  it('accepts --name=value', () => {
    expect(parseArgs(['--output=./a.mp4']).options.output).toBe('./a.mp4');
  });

  it('accepts a value containing an equals sign', () => {
    // Common with URLs and query strings, and a naive split loses everything after the first.
    expect(parseArgs(['--url', 'https://x.test/?a=1&b=2']).options.url).toBe(
      'https://x.test/?a=1&b=2',
    );
  });

  it('treats a trailing flag as a flag, not a missing value', () => {
    const args = parseArgs(['--headed']);
    expect(args.flags.has('headed')).toBe(true);
    expect(args.options.headed).toBeUndefined();
  });

  it('handles an empty command line', () => {
    expect(parseArgs([]).positionals).toEqual([]);
  });

  it('finds unknown options so they can be rejected', () => {
    // Silently ignoring a mistyped flag is how a user spends an hour wondering why their
    // setting had no effect.
    const unknown = unknownOptions(parseArgs(['--fpss', '60', '--headless']), ['fps']);
    expect(unknown.sort()).toEqual(['fpss', 'headless']);
  });
});

describe('option readers', () => {
  it('falls back when an option is missing', () => {
    expect(option(parseArgs([]), 'output', 'x')).toBe('x');
    expect(intOption(parseArgs([]), 'fps', 30)).toBe(30);
  });

  it('falls back on an unparseable integer rather than yielding NaN', () => {
    // NaN would propagate into the config and fail much later, with a much worse message.
    expect(intOption(parseArgs(['--fps', 'fast']), 'fps', 30)).toBe(30);
  });

  it('falls back on an out-of-range integer', () => {
    expect(intOption(parseArgs(['--fps', '1000']), 'fps', 30, { min: 1, max: 240 })).toBe(30);
    expect(intOption(parseArgs(['--fps', '0']), 'fps', 30, { min: 1, max: 240 })).toBe(30);
  });

  it('accepts a flag written as --flag=true', () => {
    expect(flag(parseArgs(['--headed=true']), 'headed')).toBe(true);
    expect(flag(parseArgs(['--headed=false']), 'headed')).toBe(false);
  });
});

describe('readRunOptions', () => {
  it('applies documented defaults', () => {
    expect(readRunOptions(parseArgs([]))).toMatchObject({
      output: './output/video.mp4',
      viewport: 'vertical',
      fps: 30,
      seed: 0,
      layoutScale: 2,
      headed: false,
      screencast: false,
    });
  });

  it('reads overrides', () => {
    const options = readRunOptions(
      parseArgs(['-o', 'x.mp4', '--viewport', 'landscape', '--fps', '60', '--seed', '42']),
    );

    expect(options).toMatchObject({
      output: 'x.mp4',
      viewport: 'landscape',
      fps: 60,
      seed: 42,
    });
  });

  it('accepts a viewport given as dimensions', () => {
    expect(readRunOptions(parseArgs(['--viewport', '1280x720'])).viewport).toBe('1280x720');
  });

  it('selects the screencast backend by name', () => {
    // The flag was `--fast` until measurement showed the frame pipeline is the faster of the
    // two — 1.83x realtime against 0.85x. A flag that asserts something untrue is worse than no
    // flag, so it was renamed rather than kept.
    expect(readRunOptions(parseArgs(['--screencast'])).screencast).toBe(true);
  });
});

describe('inspection recorder', () => {
  it('records operations without launching a browser', async () => {
    const { video, actions } = createInspectionRecorder({ fps: 30, seed: 1 });

    await (video as any).open('https://example.com');
    await (video as any).scene('demo', async () => {
      await (video as any).cursor.moveTo('#a');
      await (video as any).cursor.click();
      await (video as any).pause(500);
    });

    // The point of inspect: no browser, no frames, milliseconds not minutes.
    expect(actions.map((action) => action.type)).toEqual([
      'open',
      'scene',
      'cursor.moveTo',
      'cursor.click',
      'pause',
    ]);
    expect(actions.every((action) => action.scene === 'demo' || action.type === 'open')).toBe(true);
  });

  it('returns a usable result from export so scripts do not crash', async () => {
    // A script that reads `result.path` must run under inspect exactly as it does under render —
    // otherwise the scripts most worth inspecting are the ones that cannot be inspected.
    const { video } = createInspectionRecorder({ fps: 30, output: './out.mp4' });

    await (video as any).pause(1000);
    const result = (await (video as any).export()) as Record<string, unknown>;

    expect(result.path).toBe('./out.mp4');
    // 1000ms at 30fps.
    expect(result.frames).toBe(30);
    expect(result.durationMs).toBe(1000);
  });

  it('scales typing duration with the text', async () => {
    const { video, actions } = createInspectionRecorder({});
    await (video as any).type('#a', 'AAPL');
    await (video as any).type('#a', 'AAPLPLMSFT');

    const typing = actions.filter((action) => action.type === 'type');
    expect(typing[1]!.durationMs).toBeGreaterThan(typing[0]!.durationMs);
  });

  it('restores the enclosing scene afterwards', async () => {
    const { video, actions } = createInspectionRecorder({});

    await (video as any).scene('outer', async () => {
      await (video as any).pause(100);
      await (video as any).scene('inner', async () => {
        await (video as any).pause(200);
      });
      await (video as any).pause(300);
    });

    const pauses = actions.filter((action) => action.type === 'pause');
    // Without restoring, the action after the inner scene would still be attributed to it.
    expect(pauses.map((action) => action.scene)).toEqual(['outer', 'inner', 'outer']);
  });
});

describe('formatChecks', () => {
  it('marks each status distinctly', () => {
    const text = formatChecks([
      { name: 'Node.js', status: 'ok', detail: 'v20' },
      { name: 'ffmpeg', status: 'warn', detail: 'old' },
      { name: 'Target', status: 'fail', detail: 'down', fix: 'Start it.' },
    ]);

    expect(text).toContain('✓ Node.js');
    expect(text).toContain('! ffmpeg');
    expect(text).toContain('✗ Target');
    // A failing check must carry its fix, or the report is just a list of complaints.
    expect(text).toContain('Start it.');
  });
});
describe('short options', () => {
  it('parses -o the same as --output', () => {
    // The usage text advertises `-o, --output`; a parser that silently ignored one of them
    // would be worse than not offering it.
    expect(readRunOptions(parseArgs(['-o', 'x.mp4'])).output).toBe('x.mp4');
  });

  it('does not swallow a negative-looking positional as an option', () => {
    expect(parseArgs(['-5']).positionals).toEqual(['-5']);
  });
});
