# autovideo

**Create polished product videos from code.**

A developer-first framework for recording real web applications as deterministic, publishable
video. Not a screen recorder, and not a testing tool that records as a side effect — the video
is the output, and everything else exists to make that output repeatable.

```ts
import { createVideo } from 'autovideo';

const video = await createVideo({
  viewport: 'vertical', // 1080x1920 — Reels, TikTok, Shorts
  fps: 60,
  seed: 42069,
});

await video.scene('search', async () => {
  await video.open('https://yourapp.com');
  await video.cursor.moveTo('#ticker-search');
  await video.cursor.click();
  await video.type('#ticker-search', 'AAPL', { behavior: 'natural' });
  await video.press('#ticker-search', 'Enter');
  await video.pause(1200);
});

await video.export('./demo.mp4');
```

```
autovideo render ./demo.ts        # render it
autovideo inspect ./demo.ts       # see what it would do, instantly, with no browser
autovideo doctor --url <url>      # check a render could succeed
```

---

## Why it works differently

### The two backends, measured

The plan asked for the alternatives to be benchmarked rather than argued about. Both are
implemented and the comparison is a test:

| backend              | video | render    | throughput         | cursor |
| -------------------- | ----- | --------- | ------------------ | ------ |
| **frames** (default) | 4.00s | **2.18s** | **1.83× realtime** | yes    |
| `--screencast`       | 4.02s | 4.72s     | 0.85× realtime     | no     |

The screencast is the one you get out of the box, and it records in real time — so it is natural
to assume it is the fast option. Measured, it is not: it spends four seconds capturing and then
another second transcoding, while the frame pipeline finishes before the video it is producing
has finished playing. It is both slower and less capable, which is why it is not the default.

It is kept, and kept tested, because a benchmark needs both implementations to mean anything.

### The cursor is drawn, not captured

Playwright's built-in video recording **never renders the mouse cursor**. This was measured, not
assumed: sweep a mouse across a labelled box, extract frames, and look — the page renders and
there is no cursor anywhere in it. The reproduction lives in
[`research/probes/screencast-cursor/`](research/probes/screencast-cursor/).

So the cursor is a DOM element the framework positions on every frame. It scales with the layout
viewport, needs no image-compositing dependency, and looks identical on every machine. The real
browser mouse still moves underneath, so hover states and click hit-testing are genuine browser
behaviour — only what the viewer sees is ours.

### Time is counted in frames, not milliseconds

The obvious design reads the wall clock and turns elapsed time into a frame index. That produces
a video whose content is right but whose _timing_ depends on the machine — slow enough and frames
get dropped, and how many changes with CPU load.

Here, video time advances **only as frames are captured**:

```ts
// logical time = n / fps, advanced by the frame pump — never by Date.now()
```

A `pause(1000)` at 30fps emits exactly 30 frames on any machine, however slow. If capture cannot
keep up, the render takes longer — which the plan explicitly permits. The video is a pure
function of the script and the seed.

Measured: **a 10-second video renders in 5.1 seconds**, about 1.97× realtime.

### Motion is sampled, not played back

With a screencast you have to _drive_ motion in wall-clock time and hope it is captured at the
right moments — a real mouse cannot be un-moved.

Here motion is state. An action registers an animation on a track; each frame asks the track what
the cursor position is _at that logical timestamp_ and applies it. So frame 47 is a function of
47, not of how many frames the machine managed before it.

Natural motion draws from a **seeded RNG with independent named streams**, so a change to one
action's random draws cannot shift another's. Same seed, same video — and no `Math.random()`
anywhere in the framework.

### Failed runs leave nothing that looks finished

A run either produces a complete video plus a manifest, or it leaves nothing that could be
mistaken for one. The encoder writes to a scratch directory and the file is renamed into place
only after everything succeeds.

A failure produces a `VideoRenderError` naming the scene, action, selector, URL, elapsed time and
artefact paths, plus:

```
debug/<run>/
├── screenshot.png    what was on screen
├── trace.zip         full Playwright trace, openable in the trace viewer
├── console.log       browser console output, including page errors
├── error.json        the failure, structured
└── manifest.json     every scene and action with its logical timing
```

---

## Install

```sh
npm install autovideo
npx playwright install chromium
```

ffmpeg ships as a dependency, so nothing needs installing system-wide.

## Viewports

The shape is the most consequential decision in a video: 1080x1920 and 1920x1080 are not two sizes
of the same thing, they are two different products.

```ts
{ viewport: 'vertical' }                             // 1080x1920, 9:16 — the default
{ viewport: 'landscape' }                            // 1920x1080, 16:9
{ viewport: { width: 1080, height: 1350 } }          // explicit
{ viewport: { aspectRatio: '4:5', width: 1080 } }   // derived
{ viewport: '1280x720' }                             // from a string, for the CLI and YAML
```

Presets: `vertical` (9:16), `portrait` (4:5), `square` (1:1), `landscape` (16:9).

`layoutScale` (default 2) lays the page out at `output / scale` CSS pixels and enlarges it back in
the encoder. At 1:1 a dense dashboard renders body text at about 1.3% of frame width — correct,
and unreadable on a phone. It is also **76% faster**, because encoding is resolution-bound and
capture is not.

## API

```ts
await video.open(url);
await video.click(selector);
await video.type(selector, text, { behavior: 'natural', speed, variance });
await video.press(selector, 'Enter');
await video.scroll({ amount: 800, behavior: 'natural' });
await video.scrollTo(selector, { behavior: 'natural' });

await video.highlight(selector); // ring an element; moves, never stacks
await video.highlight(selector, { color: '#4ade80', durationMs: 1500 });
await video.clearHighlight();

await video.cursor.moveTo(selector); // interpolated, never teleported
await video.cursor.click();
await video.cursor.hide();

await video.pause(700); // renders 700ms of stillness
await video.waitForSelector('#chart'); // waits on state, never a sleep
await video.waitForLoadState('networkidle');

await video.scene('name', async () => {
  /* … */
});
await video.mark('Chart is visible', { selector: '#chart' });

await video.export('./out.mp4'); // idempotent
await video.dispose();
```

**Prefer state waits over sleeps.** A `pause` is for letting a viewer read something; a
`waitForSelector` is for waiting for the application. The framework enforces this distinction in
the API so the two are never confused.

**Highlighting tracks the element.** A ring is positioned from live layout every frame, not from
where the element was when you highlighted it, so it stays on target through scrolling and reflow.
Its fade is sampled in Node rather than animated by a CSS transition, so it is frame-exact like
everything else — two runs fade identically. Only one highlight is up at a time; calling
`highlight()` again moves the ring.

**Natural typing never introduces typos.** It varies inter-key timing and occasionally pauses
mid-thought. A "natural" mode that types a wrong character is worse than an even one, because the
viewer sees a mistake the application never made.

## Authenticated apps

```ts
createVideo({ browser: { storageState: './auth.json' } });
```

The path is recorded in the manifest; the contents are never read by the framework, so session
cookies cannot leak into an artefact.

## Redacting personal data

```ts
createVideo({
  browser: {
    extraCss: ['.user-email { display: none !important; }'],
  },
});
```

The framework deliberately ships **no** app-specific selectors. Hiding what must not appear is
configuration, not engine code.

## Examples

- [`examples/basic`](examples/basic) — the smallest complete script
- [`examples/vertical`](examples/vertical) — a full vertical product demo
- [`examples/natural-input`](examples/natural-input) — natural typing, scrolling and cursor work
- [`examples/highlight`](examples/highlight) — pointing the viewer at a value, with and without
  the cursor

## Security

**This framework executes arbitrary code.** A video script is an ES module with a default export
that receives the API, and it runs with your full permissions. Only run scripts you trust, and
never render a script from an untrusted source.

The framework does not log or record secrets. Manifests contain the version, seed, fps,
dimensions, URL and timing — never cookies or `storageState` contents. Diagnostic output is
written only when a run fails.

## Development

```sh
npm install
npx playwright install chromium

npm test                  # unit — fast, hermetic, no browser
npm run test:integration  # real Chromium, real ffmpeg
npm run typecheck
```

The integration suite renders against a local fixture app (`tests/fixture-app/`), so it is
hermetic and never touches the network.

Measured on an M-series laptop:

|                         |                                     |
| ----------------------- | ----------------------------------- |
| 10s @ 30fps, vertical   | 5.1s to render (1.97× realtime)     |
| Capture + encode        | ~18ms per frame at the layout split |
| Layout split (x2 vs x1) | 76% faster                          |

## Status

Phase 1 (minimal runtime) is complete and working end to end. Scenes are recorded, but camera
work, the declarative YAML format, and a port of a real production workflow are not yet built —
see [BACKLOG.md](BACKLOG.md).

### What reproducibility means here, precisely

**Guaranteed:** the same script and seed produce the same scenes, the same actions in the same
order on the same targets, and explicit pauses spanning exactly the video time they asked for.
`pause(1000)` at 30fps is 30 frames on every run, always.

**Not guaranteed:** absolute timestamps. An action that waits on the application —
`waitForSelector`, a `click` that triggers a load — takes as long as the application takes, and the
video shows that wait rather than pretending it did not happen. Across repeated runs of such a
script this varies by up to ~333ms (ten frames).

The plan asks for "substantially identical" output, not byte-identical. Two renders of a script
that contains only scripted timing produce byte-identical raw frames, which the test suite
asserts.

`ARCHITECTURE_AUDIT.md` documents why this framework replaced the screencast approach, including
the measurements that motivated it.

## Licence

MIT
