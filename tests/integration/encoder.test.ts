import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveConfig } from '../../src/config/config.js';
import {
  probeDurationSeconds,
  resolveFfmpegBinary,
  startEncoder,
  type Encoder,
} from '../../src/recorder/encoder.js';
import { VideoEncoderError } from '../../src/runtime/errors.js';
import type { Size } from '../../src/config/config.js';

/**
 * Encode real frames through a real ffmpeg.
 *
 * The argument-list unit tests cannot tell whether the arguments actually work. These can — and
 * they already have: the first version of this suite found that the MP4 muxer refuses
 * non-seekable output, which forced the encoder to write to a file instead of a pipe.
 */

/** The capture size used throughout: the CSS layout size for a 1080x1920 output. */
const CAPTURE: Size = { width: 540, height: 960 };
const OUTPUT: Size = { width: 1080, height: 1920 };

/** Build a solid-colour frame in the requested format, using ffmpeg itself. */
async function makeFrame(size: Size, colour: string, format: 'jpeg' | 'png'): Promise<Buffer> {
  const { spawnSync } = await import('node:child_process');
  const binary = resolveFfmpegBinary();

  const result = spawnSync(
    binary as string,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=${colour}:s=${size.width}x${size.height}:d=1`,
      '-frames:v',
      '1',
      '-f',
      format === 'jpeg' ? 'mjpeg' : 'image2',
      '-c:v',
      format === 'jpeg' ? 'mjpeg' : 'png',
      'pipe:1',
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );

  if (result.status !== 0 || result.stdout.length === 0) {
    throw new Error(`Could not synthesise a test frame: ${result.stderr.toString()}`);
  }
  return result.stdout;
}

describe('encoder', () => {
  let workDir: string;
  let nextPath: () => string;

  const start = (overrides: Record<string, unknown> = {}, fps = 30): Encoder =>
    startEncoder(
      resolveConfig({ fps, recorder: { frameFormat: 'png', preset: 'ultrafast', ...overrides } })
        .recorder,
      fps,
      CAPTURE,
      OUTPUT,
      nextPath(),
    );

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'autovideo-encoder-'));
    let counter = 0;
    nextPath = () => join(workDir, `out-${counter++}.mp4`);
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('encodes piped frames into a playable MP4 of the requested size', async () => {
    const encoder = start();
    const frame = await makeFrame(CAPTURE, '0x101820', 'png');

    for (let index = 0; index < 30; index++) await encoder.write(frame);
    await encoder.finish();

    const output = await readFile(encoder.destination);

    // A valid MP4 starts with an ftyp box. Byte-level assertion, because a file that merely
    // exists proves nothing.
    expect(output.subarray(4, 8).toString()).toBe('ftyp');
    expect(output.length).toBeGreaterThan(1000);
  }, 60_000);

  it('produces a duration matching the frame count', async () => {
    // 17 frames at 30fps is ~0.567s. Container rounding is to the nearest unit, so the bound is
    // a second either side rather than an exact match.
    const encoder = start();
    const frame = await makeFrame(CAPTURE, '0x203040', 'png');

    for (let index = 0; index < 17; index++) await encoder.write(frame);
    await encoder.finish();

    const duration = await probeDurationSeconds(encoder.destination);
    expect(duration).not.toBeNull();
    expect(duration as number).toBeGreaterThan(0.4);
    expect(duration as number).toBeLessThan(0.8);
  }, 60_000);

  it('reads duration from ffmpeg itself, with no ffprobe binary involved', async () => {
    // ffmpeg-static ships only ffmpeg. The reference implementation derived an ffprobe path by
    // regex-rewriting the ffmpeg path, existsSync-checked it, and therefore always got null.
    const encoder = start();
    const frame = await makeFrame(CAPTURE, '0x305040', 'png');

    for (let index = 0; index < 30; index++) await encoder.write(frame);
    await encoder.finish();

    const duration = await probeDurationSeconds(encoder.destination);
    expect(duration).not.toBeNull();
    expect(duration as number).toBeCloseTo(1, 1);
  }, 60_000);

  it('scales the layout capture up to the output size', async () => {
    const encoder = start();
    const frame = await makeFrame(CAPTURE, '0x405060', 'png');

    for (let index = 0; index < 5; index++) await encoder.write(frame);
    await encoder.finish();

    // Probe the dimensions ffmpeg actually produced, which proves the -vf scale filter applied.
    const { spawnSync } = await import('node:child_process');
    const probe = spawnSync(
      resolveFfmpegBinary() as string,
      ['-hide_banner', '-i', encoder.destination],
      { encoding: 'utf8' },
    );
    expect(probe.stderr).toMatch(/1080x1920/);
  }, 60_000);

  it('reports a decoder mismatch instead of hanging', async () => {
    // Feeding a PNG to a JPEG decoder makes ffmpeg exit. The critical property is that this
    // surfaces as a rejection: the reference failure mode was an encoder that died, closed
    // stdin, and left the writer awaiting a drain event that would never come.
    const encoder = start({ frameFormat: 'jpeg' });
    const wrongFormat = await makeFrame(CAPTURE, '0x506070', 'png');

    await encoder.write(wrongFormat);

    await expect(encoder.finish()).rejects.toBeInstanceOf(VideoEncoderError);
  }, 30_000);

  it('refuses to write after the process has exited', async () => {
    const encoder = start();
    const frame = await makeFrame(CAPTURE, '0x607080', 'png');

    for (let index = 0; index < 3; index++) await encoder.write(frame);
    await encoder.finish();

    expect(encoder.isRunning()).toBe(false);
    await expect(encoder.write(Buffer.from([0]))).rejects.toBeInstanceOf(VideoEncoderError);
  }, 30_000);

  it('explains a missing ffmpeg binary instead of failing obscurely', () => {
    const config = resolveConfig({ recorder: { ffmpegPath: '/definitely/not/here' } }).recorder;

    let thrown: unknown;
    try {
      startEncoder(config, 30, CAPTURE, OUTPUT, nextPath());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(VideoEncoderError);
    expect((thrown as VideoEncoderError).hint).toMatch(/ffmpeg/i);
  });
});
