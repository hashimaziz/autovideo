import { describe, expect, it } from 'vitest';

import { resolveConfig } from '../../src/config/config.js';
import {
  buildEncodeArgs,
  probeDurationSeconds,
  resolveFfmpegBinary,
} from '../../src/recorder/encoder.js';

const config = (overrides = {}) => resolveConfig({ recorder: overrides }).recorder;

describe('buildEncodeArgs', () => {
  it('reads raw frames from stdin as an image2pipe stream', () => {
    const args = buildEncodeArgs(
      config(),
      30,
      { width: 540, height: 960 },
      { width: 1080, height: 1920 },
      '/tmp/out.mp4',
    );

    const inputIndex = args.indexOf('-i');
    expect(args[inputIndex + 1]).toBe('pipe:0');
    expect(args).toContain('image2pipe');
  });

  it('uses mjpeg, not jpeg, as the stdin decoder', () => {
    // `jpeg` is not a decoder name. ffmpeg exits immediately with "Unknown decoder 'jpeg'", and
    // because it then closes stdin, a caller awaiting a drain event hangs instead of seeing the
    // error. This is asserted so the mistake cannot be reintroduced.
    const args = buildEncodeArgs(
      config({ frameFormat: 'jpeg' }),
      30,
      { width: 8, height: 8 },
      { width: 8, height: 8 },
      '/tmp/out.mp4',
    );
    const codecIndex = args.indexOf('-c:v');

    expect(args[codecIndex + 1]).toBe('mjpeg');
    expect(args).not.toContain('jpeg');
  });

  it('uses png as the stdin decoder for png frames', () => {
    const args = buildEncodeArgs(
      config({ frameFormat: 'png' }),
      30,
      { width: 8, height: 8 },
      { width: 8, height: 8 },
      '/tmp/out.mp4',
    );
    expect(args[args.indexOf('-c:v') + 1]).toBe('png');
  });

  it('scales the layout capture up to the output size with Lanczos', () => {
    const args = buildEncodeArgs(
      config(),
      30,
      { width: 540, height: 960 },
      { width: 1080, height: 1920 },
      '/tmp/out.mp4',
    );

    // Lanczos rather than a fast bilinear filter: the enlargement is the whole point of the
    // layout split, and bilinear softens every glyph.
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=1080:1920:flags=lanczos');
  });

  it('omits the scale filter when capture and output already match', () => {
    const args = buildEncodeArgs(
      config(),
      30,
      { width: 1080, height: 1920 },
      { width: 1080, height: 1920 },
      '/tmp/out.mp4',
    );
    expect(args).not.toContain('-vf');
  });

  it('applies the requested framerate to the input stream', () => {
    const args = buildEncodeArgs(
      config(),
      60,
      { width: 8, height: 8 },
      { width: 8, height: 8 },
      '/tmp/out.mp4',
    );
    expect(args[args.indexOf('-framerate') + 1]).toBe('60');
  });

  it('produces an H.264 MP4 profile every social platform accepts', () => {
    const args = buildEncodeArgs(
      config(),
      30,
      { width: 8, height: 8 },
      { width: 8, height: 8 },
      '/tmp/out.mp4',
    );

    expect(args).toContain('libx264');
    expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
    expect(args[args.indexOf('-movflags') + 1]).toBe('+faststart');
  });

  it('emits no audio track', () => {
    // There is no audio track, and letting ffmpeg probe for one wastes startup time.
    expect(
      buildEncodeArgs(
        config(),
        30,
        { width: 8, height: 8 },
        { width: 8, height: 8 },
        '/tmp/out.mp4',
      ),
    ).toContain('-an');
  });

  it('passes crf and preset through from config', () => {
    const args = buildEncodeArgs(
      config({ crf: 18, preset: 'medium' }),
      30,
      { width: 8, height: 8 },
      { width: 8, height: 8 },
      '/tmp/out.mp4',
    );

    expect(args[args.indexOf('-crf') + 1]).toBe('18');
    expect(args[args.indexOf('-preset') + 1]).toBe('medium');
  });

  it('can disable faststart', () => {
    const args = buildEncodeArgs(
      config({ fastStart: false }),
      30,
      { width: 8, height: 8 },
      { width: 8, height: 8 },
      '/tmp/out.mp4',
    );
    expect(args[args.indexOf('-movflags') + 1]).toBe('-movflags empty_moov');
  });

  it('overwrites rather than appending', () => {
    expect(
      buildEncodeArgs(
        config(),
        30,
        { width: 8, height: 8 },
        { width: 8, height: 8 },
        '/tmp/out.mp4',
      ),
    ).toContain('-y');
  });

  it('writes to a file path, never a pipe', () => {
    // The MP4 muxer refuses non-seekable output ("muxer does not support non seekable output"),
    // and +faststart also seeks back to rewrite the header. Piping to stdout cannot work.
    const args = buildEncodeArgs(
      config(),
      30,
      { width: 8, height: 8 },
      { width: 8, height: 8 },
      '/tmp/out.mp4',
    );
    expect(args[args.length - 1]).toBe('/tmp/out.mp4');
    expect(args).not.toContain('pipe:1');
  });
});

describe('resolveFfmpegBinary', () => {
  it('finds the bundled binary', () => {
    // ffmpeg-static is a dependency, so nothing needs installing system-wide.
    expect(resolveFfmpegBinary()).toBeTruthy();
  });

  it('prefers an explicit override', () => {
    expect(resolveFfmpegBinary('/nonexistent/ffmpeg')).toBeNull();
  });

  it('returns null rather than throwing for a missing override', () => {
    // The caller turns this into a VideoEncoderError with a fix; throwing here would lose the
    // context of which stage of the render needed it.
    expect(resolveFfmpegBinary('/definitely/not/here')).toBeNull();
  });
});

describe('probeDurationSeconds', () => {
  it('returns null when there is nothing to probe', async () => {
    await expect(
      probeDurationSeconds('/nonexistent/file.mp4', '/nonexistent/ffmpeg'),
    ).resolves.toBeNull();
  });
});
