# Probe: screencast cursor & frame-pipeline throughput

These are the experiments behind the two load-bearing claims in
[`ARCHITECTURE_AUDIT.md`](../../ARCHITECTURE_AUDIT.md) §5. They are kept in the repository so the
architecture decision can be re-verified on any machine rather than taken on trust.

Both scripts need `playwright` and `ffmpeg-static` installed (both are dependencies of this
repo) and a Chromium build (`npx playwright install chromium`).

```sh
node screencast-cursor.mjs              # claim 1: the screencast draws no cursor
node frame-pipeline-throughput.mjs       # claim 2: a frame pipeline is fast enough
```

Output (videos, extracted frames, Chromium profile) lands in `.out/`, which is gitignored.

---

## `screencast-cursor.mjs` — the screencast draws no cursor

Serves `page.html`, launches Chromium with `recordVideo` at 540×960, sweeps the mouse across the
`TARGET` box in 25 discrete moves, presses and releases, then saves the WebM and extracts frames
30/40/50.

**Look at `frame-40.png`.** The page renders correctly and the mouse has demonstrably been over
the `TARGET` box — but there is no cursor anywhere in the frame. That is why this framework
cannot build its default recording path on Playwright's screencast: the plan requires cursor
visibility as a first-class video concept, and the screencast simply never draws one.

Two dead ends are worth recording, because both produced confidently wrong results:

- **A `data:` URL renders the video blank.** Not an error — an all-white 2.4 s video, every frame.
  The probe must use real HTTP.
- **`--ss` seeking past the end of the clip silently yields no file.** Extract frames by index
  (`-vf select='eq(n\,40)'`) rather than by timestamp.

## `frame-pipeline-throughput.mjs` — the replacement is fast enough

The audit replaces the screencast with a logical-clock frame pump. That is only defensible if
piping `Page.captureScreenshot` into ffmpeg is fast enough, so this measures the real thing:
CDP capture → ffmpeg stdin → H.264 MP4, 60 frames, at both 540×960-upscaled and 1080×1920-native.

The result (54 fps of pipeline throughput at the layout split) means a 10-second 30 fps video
renders in ~5.6 s — comfortably inside the plan's target of 30 s, without any real-time
constraint.

**The trap worth knowing about:** `-f image2pipe -c:v jpeg -i pipe:0` fails with
`Unknown decoder 'jpeg'`. The valid names are `-c:v mjpeg` and `-c:v png`. ffmpeg then exits
immediately and closes stdin — so if the writer also awaits backpressure with
`once('drain')`, the process **hangs forever** instead of reporting the error. This probe
therefore reports the ffmpeg exit code explicitly, and the real encoder handles backpressure
separately.