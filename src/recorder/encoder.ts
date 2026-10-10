/**
 * The encoder: a pipe of raw frames into ffmpeg, out as an MP4.
 *
 * This is the default recording backend, and it is what makes the framework's determinism claim
 * possible. Instead of asking a screencast "send me whatever changed", the frame pump decides
 * what frame N looks like and pushes it. See ARCHITECTURE_AUDIT.md §8.
 *
 * ### Frame format on the wire
 *
 * JPEG by default, PNG on request. The choice is a real trade-off:
 *
 * - JPEG encodes ~3x faster and pipes ~4x fewer bytes, which matters because capture and encode
 *   together run at ~54fps — the throughput the whole design depends on.
 * - PNG is lossless, which is what the golden determinism suite compares. Comparing JPEG bytes
 *   across runs would test the encoder's tie-breaking rather than the framework.
 *
 * So PNG is available for tests, JPEG for production, and neither is presented as the only way.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

import type { RecorderConfig, Size } from '../config/config.js';
import { VideoEncoderError } from '../runtime/errors.js';

const require = createRequire(import.meta.url);

/**
 * Locate an ffmpeg binary.
 *
 * `ffmpeg-static` ships one as an npm dependency, so nothing needs installing system-wide.
 * `AUTOVIDEO_FFMPEG_PATH` overrides it for people who prefer their own build.
 *
 * Note that this package ships **ffmpeg only**, not ffprobe. Probing duration therefore has to
 * go through ffmpeg itself; the reference implementation derived an ffprobe path by
 * regex-rewriting the ffmpeg path, `existsSync`-checked it, and so always got null — dead code
 * that looked like it worked.
 */
export function resolveFfmpegBinary(configured?: string): string | null {
  const override = configured ?? process.env.AUTOVIDEO_FFMPEG_PATH;
  if (override) return existsSync(override) ? override : null;

  try {
    const bundled: unknown = require('ffmpeg-static');
    if (typeof bundled === 'string' && existsSync(bundled)) return bundled;
  } catch {
    // Not installed. Fall through to the null below, which produces an actionable error.
  }
  return null;
}

/** Binary name accepted on the `-c:v` decoder side of an `image2pipe` input. */
const PIPE_DECODER = {
  jpeg: 'mjpeg',
  png: 'png',
} as const;

/**
 * Build the ffmpeg argument list.
 *
 * Exported and pure so the argument list can be asserted without running ffmpeg.
 *
 * @param inputSize  Size of the frames being piped in — the CSS layout size.
 * @param outputSize Size of the finished frame — the configured output viewport.
 * @param destination Scratch file the encoder writes to. Never the final output path: a failed
 *   render must not leave something that looks like a finished video.
 */
export function buildEncodeArgs(
  config: RecorderConfig,
  fps: number,
  inputSize: Size,
  outputSize: Size,
  destination: string,
): string[] {
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    // Raw frame stream on stdin. The codec name here is the *decoder* for that input, and it
    // is `mjpeg`, not `jpeg` — `jpeg` is not a decoder name and ffmpeg exits immediately.
    '-f',
    'image2pipe',
    '-framerate',
    String(fps),
    '-c:v',
    PIPE_DECODER[config.frameFormat],
    '-i',
    'pipe:0',
  ];

  // Only rescale when the capture and the output differ, which is the normal case: the page lays
  // out at `output / layoutScale` and this enlarges it back. Lanczos keeps text legible rather
  // than blocky, which is the entire reason the layout split exists.
  if (inputSize.width !== outputSize.width || inputSize.height !== outputSize.height) {
    args.push('-vf', `scale=${outputSize.width}:${outputSize.height}:flags=lanczos`);
  }

  args.push(
    // H.264 + yuv420p + faststart is what Reels, TikTok and Shorts all accept without a
    // re-encode by the viewer.
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
    // No audio track exists. `-an` keeps the encoder from probing for one and stalling.
    '-an',
    // The output is a real file, never a pipe. The MP4 muxer refuses non-seekable output
    // ("muxer does not support non seekable output"), and +faststart additionally seeks back to
    // rewrite the header. A fragmented-MP4 pipe would satisfy the muxer but is less widely
    // compatible and forfeits faststart, so the encoder writes to a scratch file that the caller
    // renames into place only once the render succeeds.
    destination,
  );

  return args;
}

/** Handle to a running encoder. */
export interface Encoder {
  /** Absolute path of the scratch file the encoder is writing. */
  readonly destination: string;
  /**
   * Write one frame.
   *
   * Backpressure is handled here rather than by the caller, and deliberately without ever
   * rejecting: if the encoder dies, the caller must learn about it through {@link Encoder.done}
   * rather than through a stream error on a pipe it does not own.
   */
  write(frame: Buffer): Promise<void>;
  /** Stop accepting frames, flush, and resolve. */
  finish(): Promise<void>;
  /** Reject when the process exits non-zero, or the spawn itself failed. */
  readonly done: Promise<void>;
  /** Whether the process is still running. */
  isRunning(): boolean;
}

/**
 * Start an encoder.
 *
 * @param destination Scratch path for the MP4. Callers write to a run directory and rename on
 *   success, so a failed render never leaves a file that looks finished.
 * @throws {VideoEncoderError} when no ffmpeg binary can be found.
 */
export function startEncoder(
  config: RecorderConfig,
  fps: number,
  inputSize: Size,
  outputSize: Size,
  destination: string,
): Encoder {
  const binary = resolveFfmpegBinary(config.ffmpegPath);
  if (!binary) {
    throw new VideoEncoderError('No ffmpeg binary found.', {
      hint: 'Run `npm install` to fetch the bundled ffmpeg, or set AUTOVIDEO_FFMPEG_PATH to your own build.',
    });
  }

  const args = buildEncodeArgs(config, fps, inputSize, outputSize, destination);
  const child = spawn(binary, args, {
    // stdout is unused: output goes to the destination file, because the MP4 muxer needs a
    // seekable target.
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  // ffmpeg is chatty even at loglevel error; keep a bounded tail for the failure message.
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });

  // An unhandled 'error' on a spawn (binary vanished, permissions) would otherwise become an
  // unhandled rejection at some unrelated point in the run.
  let spawnError: Error | undefined;
  child.on('error', (error) => {
    spawnError = new VideoEncoderError(`Could not run ffmpeg at ${binary}: ${error.message}`, {
      cause: error,
    });
  });

  let exited = false;
  const done = new Promise<void>((resolve, reject) => {
    child.on('close', (code, signal) => {
      exited = true;
      if (spawnError) {
        reject(spawnError);
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new VideoEncoderError(
          `ffmpeg exited with ${signal ? `signal ${signal}` : `code ${String(code)}`}` +
            (stderr.trim() ? `:\n${stderr.trim()}` : ''),
          // A JPEG pipe mismatch is the most common cause, so it gets a specific hint.
          config.frameFormat === 'jpeg'
            ? {
                hint: 'If the pipe format is wrong, check that every frame written is a complete JPEG.',
              }
            : {},
        ),
      );
    });
  });

  // Nothing else may await this before the run ends, so a rejection here must not be unhandled.
  // The real failure surfaces via `done`, which the pump always awaits.
  done.catch(() => undefined);

  return {
    destination,

    write(frame: Buffer): Promise<void> {
      if (exited) {
        return Promise.reject(
          new VideoEncoderError('Tried to write a frame after ffmpeg exited.', {
            hint: 'The encoder crashed earlier in the render; check the recorded frame format and dimensions.',
          }),
        );
      }

      const stdin = child.stdin;
      if (!stdin) {
        return Promise.reject(new VideoEncoderError('ffmpeg was started without a stdin pipe.'));
      }

      return new Promise<void>((resolve) => {
        // Node's writable returns false when its internal buffer is full. Waiting for 'drain'
        // applies backpressure to the frame pump, which is the only thing keeping memory bounded
        // during a long render. It must never be combined with an await that can hide an
        // encoder death — `done` is the authority on that.
        if (stdin.write(frame)) {
          resolve();
          return;
        }
        stdin.once('drain', () => resolve());
      });
    },

    async finish(): Promise<void> {
      if (exited) {
        // Already dead; surface why rather than pretending the flush succeeded.
        await done.catch(() => undefined);
        return;
      }
      child.stdin?.end();
      await done;
    },

    done,

    isRunning: () => !exited,
  };
}

/**
 * Read a media file's duration in seconds, using ffmpeg's own progress output.
 *
 * There is no ffprobe binary in `ffmpeg-static`, so this parses ffmpeg's stderr instead of
 * shelling out to a tool that is not there.
 */
export async function probeDurationSeconds(
  file: string,
  configured?: string,
): Promise<number | null> {
  const binary = resolveFfmpegBinary(configured);
  if (!binary) return null;

  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(binary, ['-hide_banner', '-i', file], { encoding: 'utf8' });

  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(result.stderr ?? '');
  if (!match) return null;

  const [, hours, minutes, seconds] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}
