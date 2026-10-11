# Architecture — empirical findings and rejected approaches

This document records _why_ the framework is built the way it is. Most of it is empirical: several
decisions here contradict the obvious choice, and the obvious choice was measured first rather
than assumed.

It also records what was tried and rejected, because "we measured it and it was worse" is the only
satisfying reason not to use an approach that looks obviously right.

---

## 1. Playwright's screencast does not render the cursor

**Probe.** A local page with two labelled boxes. The mouse was swept across the frame in 25
discrete `page.mouse.move()` steps spanning one box, then pressed and released. The WebM was
extracted and single frames pulled out at several indices and inspected visually.

**Result.** The page content renders correctly at the expected size, and the mouse is
demonstrably over drawn content — **but no cursor appears in any extracted frame.**

This is decisive. A framework whose stated goal treats cursor movement as a first-class video
concept cannot build its default recording path on a backend that cannot draw one.

So the framework **draws the cursor itself**, as a DOM overlay composited into the page. The
cursor overlay is re-placed every frame from a motion track rather than being driven by the
browser's input, which is what makes it visible _and_ frame-exact at the same time.

## 2. The screencast is wall-clock, not frame-deterministic

The same probe reports a duration and frame rate for a script whose actual interaction took
noticeably less — frame timing is whatever the compositor happened to emit, and it includes the
teardown tail. That tail is why any screencast path must trim.

This gives approximate determinism at best: re-running a script produces a video of the same
_shape_, not the same _frames_.

## 3. Capture and encode throughput

Sustained loop of 60 frames, capture → ffmpeg stdin → H.264 MP4.

| Layout → output               | Capture only                   | Capture + encode                                  |
| ----------------------------- | ------------------------------ | ------------------------------------------------- |
| 540×960 → 1080×1920 (Lanczos) | 16.5 ms/frame (60 fps)         | **18.4 ms/frame (54 fps)** — stable across 3 runs |
| 1080×1920 native              | 16.5–20.0 ms/frame (50–61 fps) | 21.9–35.3 ms/frame (28–46 fps) — variable         |

Two things follow:

- **Capture is resolution-independent** (~16–20 ms, about one compositor frame) and is not the
  bottleneck.
- **Encoding is resolution-bound, and the native-1080 path is noisy.** The layout-split figure was
  identical to 0.1 ms across three runs; the native figure swung between 22 and 35 ms, presumably
  on x264 thread scheduling.

So capturing at layout resolution is worth somewhere between **1.2× and 1.9×** end-to-end, and is
_never worse_ — which is the property that matters, given the demand for reproducible render
times.

A 10-second 30fps video therefore renders in roughly **5.6 s**, well inside the target, without
the wall-clock screencast at all.

## 4. Frame pipeline vs. screencast, measured end to end

Both backends were implemented and benchmarked on the same script:

|                 | Frames (default) | Screencast |
| --------------- | ---------------- | ---------- |
| Video produced  | 4.00 s           | 4.02 s     |
| Render time     | 2.18 s           | 4.72 s     |
| Realtime factor | **1.83×**        | 0.85×      |
| Cursor visible  | Yes              | **No**     |

The frame pipeline is both faster and the only one that draws a cursor. The screencast backend
therefore exists as a **preview/comparison** tool — useful when debugging a page, useless as a
default — and is selected with `--screencast`.

A `--fast` flag was also implemented and then **removed**: its measured effect on the frame
pipeline was nil, so a flag promising speed it did not deliver was worse than no flag.

## 5. An ffmpeg input-decoder gotcha

`-f image2pipe -c:v jpeg -i pipe:0` fails with `Unknown decoder 'jpeg'`. The correct values are
`-c:v mjpeg` (JPEG) and `-c:v png` (PNG).

Getting this wrong kills ffmpeg immediately, which closes stdin, which **deadlocks any
`await once('drain')` backpressure loop**. Worth recording precisely because the symptom appears
somewhere other than the cause.

## 6. Defects not to reintroduce

Found during earlier implementation work. None are inherited; two are subtle enough to be written
again by accident.

1. **Duplicate object keys silently discard flags.** An object literal that spreads an `args` array
   and then declares a _second_ `args` key loses the first entirely — the later key wins.
   TypeScript does not flag this.

2. **`ffprobe` does not exist.** `ffmpeg-static` ships only `ffmpeg`. Code that derives an ffprobe
   path by rewriting the ffmpeg path and `existsSync`-checks it returns `null` every time. If you
   need the duration, ffprobe it another way or measure it yourself.

3. **Init-script ordering is load-bearing and easy to lose.** Scripts registered after a page has
   loaded never fire, so page styling and automation-flag hiding must be registered before
   navigation, not after.

4. **The esbuild `__name` portability trap.** Named functions passed to `page.evaluate` are
   rewritten by some TypeScript runners with a `__name` helper that does not exist in the browser.
   They throw — and inside a `.catch` they _silently report success_. This framework passes strings
   to `page.evaluate` throughout rather than functions, precisely to avoid it. It is documented at
   the affected call sites, but it is a property of the _runner_, not of this code: a different
   runner could invalidate the reasoning.

## 7. Two rules that must be singular

Both of these were separate definitions in one file, and both caused silent, total failure.

**One definition of the scrolling element.** Measurement used `document.scrollingElement` while
every other part of the module checked `body` first. On a page that scrolls its `BODY`,
`scrollingElement` still reports `HTML` — which never scrolls, and therefore reports a scroll limit
of zero. Since measurement is what computes how far to scroll, _every_ scripted scroll clamped to
zero. No error, no warning; the render "succeeded" and the video sat still while the manifest
recorded scrolls that had not happened.

**One definition of the direct-invocation check.** The CLI ran only when `import.meta.url` equalled
the URL of `process.argv[1]`. npm invokes a bin through a **symlink** in `node_modules/.bin`, so
that comparison is false for every installed package: the CLI exited 0 having done nothing, with no
error to suggest otherwise.

The general lesson: when a value is needed in more than one place, derive it once. Two independent
answers to "which element scrolls" or "am I being run" do not produce two slightly different
behaviours — they produce a success that does nothing.

## 8. Rendering a real application is the only real test

Several bugs here were invisible to a suite that only ever rendered a local fixture, and surfaced
immediately against a real application:

- **A pre-filled input.** Typing appends, so typing a ticker into a field already containing one
  produced `AAPL` + `AAPL`. The endpoint rejected it, and the resulting 500 read as a flake.
- **A page that scrolls its body.** The bug in §7. The fixture scrolled the document; the real app
  did not. Every test asserting "the scroll happened" passed the whole time.
- **Install-time behaviour.** Building and unit-testing the package was not enough; packing a
  tarball, installing it into a clean project, and _using_ it found four defects — a stale `main`,
  a missing shebang, the silent bin above, and the headline API not being exported at all.

A fixture page can only ever exercise the layout you gave it. Prefer assertions about behaviour
("the element ends up **centred**, not merely reachable") over assertions about mechanics ("the
scroll call returned"), because the former fail when the mechanism is wrong even on the layout
that seemed to work.
