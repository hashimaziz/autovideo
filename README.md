> ## ⚠️ Licence — commercial use is not free
>
> autovideo is **source-available, not open source**, under a split licence.
>
> - **Individuals, students, hobbyists, nonprofits, education, research, government, and
>   open-source contributors: free.** No registration, no key, no revenue threshold.
> - **Companies using it to produce advertising, marketing, or client-facing video: a paid
>   commercial licence is required.**
>
> If the video you make is something you sell, or something that earns money for a business, it is
> commercial. See [COMMERCIAL.md](COMMERCIAL.md) for exactly what that covers, and
> [LICENSE](LICENSE) / [TERMS.md](TERMS.md) for the terms themselves.

# autovideo

**Turn a web app into a polished product video, from code.**

autovideo drives a real browser — real clicks, real typing, real scrolling — and encodes the result
to MP4. The video is the output, not a side effect of testing.

```ts
import { createVideo } from '@saltyhasbrown/autovideo';

const video = await createVideo({ viewport: 'vertical', fps: 60, seed: 42069 });

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

```sh
npm install @saltyhasbrown/autovideo
npx playwright install chromium
```

Requires Node 20.11+. ffmpeg ships with the package; nothing needs installing system-wide.

To start from a working script:

```sh
npx autovideo init          # writes video.ts
npx autovideo doctor --url https://yourapp.com   # check it could work
npx autovideo render video.ts -o ./demo.mp4
```

Check what a script would do, without rendering anything or launching a browser:

```sh
npx autovideo inspect video.ts
```

---

## Contents

- [What it's for](#what-its-for)
- [How it works](#how-it-works)
- [Viewports](#viewports)
- [API](#api)
- [Authenticated apps](#authenticated-apps)
- [Redacting personal data](#redacting-personal-data)
- [Reproducibility](#reproducibility)
- [Examples](#examples)
- [Performance](#performance)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Development](#development)
- [Licence](#licence)

---

## What it's for

Product demos, changelog videos, onboarding walkthroughs, app-store listings, social clips — the
kind of video that normally means either a screen recorder or a developer with too much free time.

It's aimed at the case where you need the video to be **repeatable**: re-render it when the UI
changes, produce the same clip for twelve tickers, or generate one per customer without hand-editing
anything. The same script and seed produce the same video, every run.

**Not** a screen recorder, and not a test tool that records as a side effect. Both of those make the
video an output you tolerate rather than one you specify.

### What it doesn't do

- **No camera moves.** No zooms, pans, or 3D transitions. The viewport is fixed; motion comes from
  the cursor, scrolling, and highlighting.
- **No declarative YAML format.** Scripts are TypeScript. There is no alternative authoring mode.
- **No audio.** Output is video only.
- **No lip-sync or voiceover.** Pair it with your own tooling.

If you need any of those, this is the wrong tool and you should keep looking.

## How it works

### The two backends, measured

Two recording backends are implemented, and the comparison is a benchmark rather than an argument:

| backend              | video | render    | throughput         | cursor |
| -------------------- | ----- | --------- | ------------------ | ------ |
| **frames** (default) | 4.00s | **2.18s** | **1.83× realtime** | yes    |
| `--screencast`       | 4.02s | 4.72s     | 0.85× realtime     | no     |

The screencast is the obvious choice — it's what Playwright gives you out of the box, and it records
in real time, so it is natural to assume it is fast. Measured, it is not: it spends four seconds
capturing and another second transcoding, while the frame pipeline finishes before the video it is
producing has finished playing.

It's slower _and_ less capable, which is why it isn't the default. It's kept, and kept tested,
because a benchmark needs both implementations to mean anything.

### The cursor is drawn, not captured

Playwright's built-in video recording **never renders the mouse cursor**. This was measured rather
than assumed: sweep a mouse across a labelled box, extract frames, look. The page renders and there
is no cursor anywhere in it.

So autovideo draws the cursor as a DOM element it positions every frame. It needs no
image-compositing dependency, it scales with the layout viewport, and it looks identical on every
machine. The real browser mouse still moves underneath, so hover states and click hit-testing are
genuine browser behaviour — only what the viewer sees belongs to us.

### Time is counted in frames, not milliseconds

The obvious design reads the wall clock and converts elapsed time into a frame index. That produces
a video whose content is right but whose _timing_ depends on the machine — and how many frames get
dropped changes with CPU load.

Here, video time advances **only as frames are captured**:

```ts
// logical time = n / fps, advanced by the frame pump — never by Date.now()
```

A `pause(1000)` at 30fps emits exactly 30 frames on any machine, however slow. If capture can't keep
up the render takes longer in wall-clock terms; the video itself doesn't change. It is a function of
the script and the seed, and of nothing else.

### Motion is sampled, not played back

With a screencast you have to _drive_ motion in wall-clock time and hope it was captured at the
right moments — a real mouse can't be un-moved.

Here motion is state. An action registers an animation on a track; each frame asks the track what the
cursor position is _at that logical timestamp_ and applies it. Frame 47 is a function of 47, not of
however many frames the machine managed before it.

Natural motion draws from a **seeded RNG with independent named streams**, so changing one action's
random draws can't shift another's. Same seed, same video — and no `Math.random()` anywhere in the
framework.

### Failed runs leave nothing that looks finished

A run either produces a complete video plus a manifest, or it leaves nothing that could be mistaken
for one. The encoder writes to a scratch directory and the file is renamed into place only after
everything succeeds.

A failure raises a `VideoRenderError` naming the scene, action, selector, URL, elapsed time and
artefact paths, and writes:

```
debug/<run>/
├── screenshot.png    what was on screen
├── trace.zip         full Playwright trace, openable in the trace viewer
├── console.log       browser console output, including page errors
├── error.json        the failure, structured
└── manifest.json     every scene and action with its logical timing
```

## Viewports

The shape is the most consequential decision in a video: 1080×1920 and 1920×1080 aren't two sizes of
the same thing, they're two different products.

```ts
{ viewport: 'vertical' }                             // 1080x1920, 9:16 — the default
{ viewport: 'landscape' }                            // 1920x1080, 16:9
{ viewport: { width: 1080, height: 1350 } }          // explicit
{ viewport: { aspectRatio: '4:5', width: 1080 } }   // derived
{ viewport: '1280x720' }                             // from a string, for the CLI and config
```

Presets: `vertical` (9:16), `portrait` (4:5), `square` (1:1), `landscape` (16:9).

`layoutScale` (default 2) lays the page out at `output / scale` CSS pixels and enlarges it back in
the encoder. At 1:1 a dense dashboard renders body text at about 1.3% of frame width — correct, and
unreadable on a phone. It's also **76% faster**, because encoding is resolution-bound and capture
isn't.

## API

```ts
// Navigation
await video.open(url);
await video.reload();

// Actions
await video.click(selector);
await video.doubleClick(selector);
await video.type(selector, text, { behavior: 'natural', speed, variance });
await video.fill(selector, text);
await video.press(selector, 'Enter');
await video.hover(selector);
await video.focus(selector);
await video.select(selector, value);

// Motion
await video.scroll({ amount: 800, behavior: 'natural' });
await video.scrollTo(selector, { behavior: 'natural' });

await video.cursor.moveTo(selector); // interpolated, never teleported
await video.cursor.click();
await video.cursor.hide();

// Highlighting
await video.highlight(selector); // ring an element; moves, never stacks
await video.highlight(selector, { color: '#4ade80', durationMs: 1500 });
await video.clearHighlight();

// Timing
await video.pause(700); // renders 700ms of stillness
await video.waitForSelector('#chart'); // waits on state, never a sleep
await video.waitForLoadState('networkidle');

// Structure
await video.scene('name', async () => {
  /* … */
});
await video.mark('Chart is visible', { selector: '#chart' });

// Output
await video.export('./out.mp4'); // idempotent
await video.dispose();
```

### Prefer state waits over sleeps

A `pause` is for letting a viewer read something. A `waitForSelector` is for waiting on the
application. The API keeps them separate so they're never confused — and using the wrong one is the
most common cause of a video that looks broken because it filmed a spinner.

### Highlighting tracks the element

The ring is positioned from live layout every frame, not from where the element was when you
highlighted it, so it stays on target through scrolling and reflow.

Its fade is sampled in Node rather than animated by a CSS transition, so it's frame-exact like
everything else — two runs fade identically. Only one highlight is up at a time; calling
`highlight()` again moves the ring rather than stacking a second one.

### Natural typing never introduces typos

It varies inter-key timing and occasionally pauses mid-thought. A "natural" mode that types a wrong
character is worse than an even one, because the viewer sees a mistake the application never made.

### Several videos at once

```ts
await Promise.all(['aapl', 'msft', 'nvda'].map((ticker) => renderScript(ticker)));
```

Renders are independent and safe to run concurrently, including into the same output directory: each
takes its own scratch space and its own debug stamp.

## Authenticated apps

```ts
createVideo({ browser: { storageState: './auth.json' } });
```

`storageState` is a Playwright file exported from a signed-in session. Google OAuth can't be
completed unattended, so you sign in once by hand and reuse the result:

```sh
npx playwright codegen --save-storage=auth.json https://yourapp.com/login
# sign in by hand, then close the browser
```

The path is recorded in the manifest; the contents are never read by the framework, so session
cookies can't leak into an artefact.

> Keep `storage-state*.json` and any browser profile directory out of version control. Both contain
> live session credentials. This repository's `.gitignore` already excludes both as a reminder.

## Redacting personal data

```ts
createVideo({
  browser: {
    extraCss: ['.user-email { display: none !important; }'],
  },
});
```

The framework deliberately ships **no** app-specific selectors. Hiding what must not appear is
configuration, not engine code — the framework has no idea what your application calls its own DOM.

## Reproducibility

**Guaranteed.** The same script and seed produce the same scenes, the same actions in the same order
on the same targets, and explicit pauses spanning exactly the video time they asked for.
`pause(1000)` at 30fps is 30 frames on every run, always.

**Not guaranteed: absolute timestamps.** An action that waits on the application — `waitForSelector`,
a `click` that triggers a load — takes as long as the application takes, and the video shows that
wait rather than pretending it didn't happen. Across repeated runs this varies by up to ~333ms at
30fps (ten frames).

Scripts containing only scripted timing produce byte-identical raw frames, which the test suite
asserts.

## Examples

All examples accept a target URL, so they run against anything:

```sh
AUTOVIDEO_TARGET_URL=https://yourapp.com autovideo render examples/basic/basic.ts
```

| example                                            | what it shows                                    |
| -------------------------------------------------- | ------------------------------------------------ |
| [`examples/basic`](examples/basic)                 | the smallest complete script                     |
| [`examples/vertical`](examples/vertical)           | a full vertical product demo                     |
| [`examples/natural-input`](examples/natural-input) | natural typing, scrolling and cursor work        |
| [`examples/highlight`](examples/highlight)         | directing attention, with and without the cursor |

## Performance

Measured on an M-series laptop:

|                         |                                     |
| ----------------------- | ----------------------------------- |
| 10s @ 30fps, vertical   | 5.1s to render (1.97× realtime)     |
| Capture + encode        | ~18ms per frame at the layout split |
| Layout split (×2 vs ×1) | 76% faster                          |

Encode is the bottleneck; capture is roughly one compositor frame regardless of resolution.

## Troubleshooting

**`Chromium is not installed for Playwright`**

```sh
npx playwright install chromium
```

To use a browser you already have instead:

```ts
createVideo({
  browser: {
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  },
});
```

A wrong path is reported as a configuration mistake, distinctly from "no browser is installed", so a
typo never sends you to download a second browser. `autovideo doctor` reports the same checks.

**`Selector ... did not reach state "visible" within Nms`**

The element isn't appearing. The error names the scene and selector, and `debug/<run>/` has a
screenshot, a console log and a network log — check the network log first, since the usual cause is a
failing API call rather than a missing element.

**The video doesn't scroll**

Some apps scroll an inner element rather than the document. autovideo detects this, but if a script
renders a static page, check that the target element actually exists at the point it's scrolled to.

**A render produced a file but it's the wrong length**

Compare the manifest against what you expected: `durationMs`, frame count, and the per-scene
timings are all recorded. A scene that ended far shorter than its pauses probably failed to find its
selector.

## Security

**autovideo executes arbitrary code.** A video script is an ES module that runs with your full
permissions. Only run scripts you trust, and never render a script from an untrusted source.

The framework does not log or record secrets. Manifests contain the version, seed, fps, dimensions,
URL and timing — never cookies or `storageState` contents. Diagnostic artefacts (which include
screencast frames of whatever was on screen) are written only when a run fails, so treat a
`debug/` directory from an authenticated session as sensitive.

## Development

```sh
npm install
npx playwright install chromium

npm test                  # unit — fast, hermetic, no browser
npm run test:integration  # real Chromium, real ffmpeg
npm run typecheck
npm run build
```

The integration suite renders against a local fixture app (`tests/fixture-app/`), so it is hermetic
and never touches the network.

[`ARCHITECTURE.md`](ARCHITECTURE.md) records the measurements behind the design decisions, including
the approaches that were tried and rejected. [`BACKLOG.md`](BACKLOG.md) tracks what is planned.

## Licence

Split licence, summarised at the top of this file. The legal text is the
[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/),
reproduced verbatim in [`LICENSES/`](LICENSES/), with a plain-language reading in
[TERMS.md](TERMS.md) and the commercial boundary in [COMMERCIAL.md](COMMERCIAL.md).

**Free:** individuals, personal projects, learning, hobby, open-source development, nonprofits,
education, research, government, and evaluation.

**Requires a paid licence:** any use producing video for a business — advertising, marketing, or as a
paid client deliverable.

MIT was deliberately not used: it grants unrestricted commercial use to anyone permanently, which is
incompatible with charging for what this software is for.
