/**
 * The screencast recording backend.
 *
 * **Preview-only, and not even the fast option.** It exists because the plan asks for the
 * alternatives to be benchmarked rather than argued about, and a benchmark needs both
 * implementations to be meaningful. Anyone can therefore check the audit's conclusion instead of
 * taking it on faith — including the part that surprised us.
 *
 * The obvious expectation is that the screencast is the quick one: it is what Playwright gives
 * you out of the box, and it records in real time. Measured end to end, that is not true. On a
 * four-second video:
 *
 *     frames      4.00s video in 2.18s   (1.83x realtime)
 *     screencast  4.02s video in 4.72s   (0.85x realtime)
 *
 * The screencast spends four seconds capturing in real time and then a further second
 * transcoding, while the frame pipeline finishes before the video it is producing has finished
 * playing. So it is slower *and* less capable, which is why it is not the default for three
 * further measured reasons:
 *
 * 1. **It never draws a cursor.** Sweep a mouse across a labelled box, extract frames, look:
 *    the page renders and there is no cursor anywhere. A framework whose stated goal is cursor
 *    visibility as a first-class concept cannot default to this.
 *    See [`ARCHITECTURE.md`](../../ARCHITECTURE.md) §1.
 *
 * 2. **It is wall-clock timed, so frames are not reproducible.** The timing is whatever the
 *    compositor emitted.
 *
 * 3. **It only ever scales down.** Requesting a capture larger than the viewport yields grey
 *    padding rather than an enlargement, so this backend cannot use the layout-split zoom.
 *    Verified in [`ARCHITECTURE.md`](../../ARCHITECTURE.md) §3.
 *
 * Point 3 is why a screencast render is legible only at 1:1: the page lays out at the output
 * resolution, so dense dashboards render text at roughly 1.3% of frame width. That is inherent to
 * the backend, not a configuration mistake — which is itself part of the argument for the frame
 * pipeline being the default.
 */

import { spawn } from 'node:child_process';
import { rename, rm } from 'node:fs/promises';

import type { RecorderConfig, Size } from '../config/config.js';
import { VideoEncoderError } from '../runtime/errors.js';
import { resolveFfmpegBinary } from './encoder.js';

/** Options handed to {@link startScreencastRecorder}. */
export interface ScreencastOptions {
  config: RecorderConfig;
  /** Output frame size. The browser viewport is set to match: no upscaling is possible. */
  size: Size;
  /** Scratch path for the raw WebM. */
  scratchVideo: string;
  /** Final MP4 path. */
  destination: string;
}

/** A running screencast capture. */
export interface ScreencastRecorder {
  /** Flush the WebM and convert it to MP4. */
  finish(trimSeconds?: number): Promise<void>;
}

/**
 * Convert a screencast WebM into an H.264 MP4.
 *
 * No rescale filter: the capture is already at the output size, and `-vf` with an identity scale
 * would only cost another full-resolution pass.
 */
async function webmToMp4(input: string, output: string, config: RecorderConfig): Promise<void> {
  const binary = resolveFfmpegBinary(config.ffmpegPath);
  if (!binary) {
    throw new VideoEncoderError('No ffmpeg binary found.', {
      hint: 'Run `npm install`, or set AUTOVIDEO_FFMPEG_PATH.',
    });
  }

  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    input,
    '-c:v',
    'libx264',
    '-preset',
    config.preset,
    '-crf',
    String(config.crf),
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    config.fastStart ? '+faststart' : '-movflags empty_moov',
    '-an',
    output,
  ];

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on('error', (error) =>
      reject(new VideoEncoderError(`Could not run ffmpeg: ${error.message}`, { cause: error })),
    );
    child.on('close', (code) =>
      code === 0
        ? resolvePromise()
        : reject(
            new VideoEncoderError(
              `ffmpeg exited with code ${String(code)} while converting the screencast` +
                (stderr.trim() ? `:\n${stderr.trim()}` : ''),
            ),
          ),
    );
  });
}

/**
 * Start a screencast capture on an already-configured context.
 *
 * The context must have been created with `recordVideo` pointing at a scratch directory and a
 * `size` equal to `options.size` — the browser viewport has to match, because a larger capture is
 * padded rather than scaled.
 */
export function startScreencastRecorder(
  saveCapture: (destination: string) => Promise<void>,
  options: ScreencastOptions,
): ScreencastRecorder {
  const { scratchVideo, destination } = options;

  return {
    async finish(trimSeconds?: number): Promise<void> {
      await saveCapture(scratchVideo);

      if (trimSeconds !== undefined && trimSeconds <= 0) {
        await rm(scratchVideo, { force: true });
        throw new VideoEncoderError('The screencast produced no frames.', {
          hint: 'This usually means the browser closed before the first frame rendered.',
        });
      }

      // The capture outlives its content: context teardown keeps the screencast running over a
      // static page, which would otherwise ship as a frozen tail. Trimming to the script's own
      // duration removes it.
      await webmToMp4(scratchVideo, destination, options.config);
      await rm(scratchVideo, { force: true });
    },
  };
}

/**
 * Trim a finished MP4 to `seconds`.
 *
 * Kept separate because the screencast's duration is only knowable after conversion, whereas the
 * frame pump knows it exactly as it writes.
 */
export async function trimVideo(
  file: string,
  seconds: number,
  config: RecorderConfig,
): Promise<void> {
  const binary = resolveFfmpegBinary(config.ffmpegPath);
  if (!binary) return;

  // A real `.mp4` extension, not `.trimmed`, so the container is unambiguous.
  const temporary = `${file}.trim.mp4`;
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      binary,
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        file,
        '-t',
        seconds.toFixed(3),
        // Re-encode rather than stream-copy: a copy cannot cut on a non-keyframe without
        // starting mid-GOP, which shows as a flash of garbage.
        '-c:v',
        'libx264',
        '-preset',
        config.preset,
        '-crf',
        String(config.crf),
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        '-an',
        // Stated explicitly as well as encoded in the filename: ffmpeg infers a container from
        // the output name, and without one of the two it exits with "Unable to find a suitable
        // output format".
        '-f',
        'mp4',
        temporary,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolvePromise()
        : reject(new VideoEncoderError(`Trimming failed: ${stderr.trim()}`)),
    );
  });

  await rename(temporary, file);
}
