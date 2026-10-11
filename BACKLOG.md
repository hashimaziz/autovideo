# Backlog

Known issues and unfinished work, newest first. Each entry says what is observed, what has been
ruled out, and what the next step is — so nobody has to re-derive it.

Recently resolved items are kept rather than deleted, under a struck-through heading, because the
_reasoning_ is usually the valuable part and because a future change can reintroduce them.

---

## ~~P0 — Intermittent frame-pump hang~~ RESOLVED

**Status:** fixed in `fix(runtime): serialise page access and suppress capture during navigation`.

**Was:** roughly 1 render in 9 produced no frames for 30 seconds and then failed with
`Video time stopped advancing ... No frames were produced for 30000ms`. Before the mitigations
below landed it was closer to 1 in 2.

### Root cause — three bugs, all in the same area

1. **`PageGate.acquire()` awaited the wrong thing.** `#enqueue` returns
   `{ promise, waiter, cancel }`, and the code did `await this.#enqueue(priority)` — awaiting a
   plain object, which resolves on the next microtask. So every queued caller returned
   immediately believing it held the gate, and **nothing was ever serialised**. The gate was
   decorative.

2. **Navigation never went through the gate at all.** Several earlier patches to
   `src/video/index.ts` had silently failed to apply, so `open()` and `reload()` bypassed it
   entirely. The pump could therefore be inside a `page.evaluate` when `goto()` began — and every
   CDP call _hangs_ rather than fails during a navigation.

3. **Capture ran in the window around a navigation.** Frames captured between `goto()` being
   called and the browser emitting `framenavigated`, or between `load` firing and `goto`
   resolving, advanced logical time by one frame interval — shifting every later timestamp.

### Fixes

- `await this.#enqueue(priority).promise`
- `open()` and `reload()` take the gate with priority, and suppress capture for the whole
  navigation
- The pump skips the pre-navigation blank page entirely. `Page.captureScreenshot` _succeeds_ on
  `about:blank` and returns a small white image, so a URL check after a failure never fired and
  frame 0 was written or not depending on who won the race
- A frame whose `stop()` lands mid-capture is dropped rather than written, which is what made
  `pause(1000)` at 30fps emit 31 frames

### Verified

- `video.test.ts` + `determinism.test.ts`, 14 consecutive full runs: **0 failures**
- Two renders of the same script produce identical scenes, actions, targets and pause durations
- All 15 `PageGate` unit tests pass, including priority, cancellation and ghost-owner cases

### What is still not guaranteed, by design

Absolute timestamps and action durations derived from them. An action that waits on the
application — `waitForSelector`, a `click` that triggers a load — takes as long as the app takes,
and the video shows that wait rather than pretending it did not happen. Measured variation across
runs of such a script: up to 333ms, ten frames.

Explicit pauses _are_ exact, because they wait on logical time: `pause(1000)` at 30fps is 30
frames on every run. That is the sharp part of the guarantee, and it is what the determinism suite
asserts.

---

## ~~P1 — Screencast backend declared but not implemented~~ DONE

**Status:** implemented, benchmarked, and renamed. Was: `--fast` silently did nothing.

### What it turned out to be

The obvious assumption was that Playwright's screencast is the _quick_ backend — it is what
Playwright gives you out of the box, and it records in real time. Measured end to end:

| backend    | video | render | throughput     |
| ---------- | ----- | ------ | -------------- |
| frames     | 4.00s | 2.18s  | 1.83x realtime |
| screencast | 4.02s | 4.72s  | 0.85x realtime |

The screencast spends four seconds capturing and then another second transcoding. The frame
pipeline finishes before the video it is producing has finished playing. So the flag was named
for a property it does not have, and has been renamed `--screencast`.

The two other documented limits are now regression tests rather than prose:

- **No cursor.** Chromium's screencast does not render one, and neither does the framework's DOM
  overlay, because the capture contains only what the page painted.
- **Scales down only.** Requesting a capture larger than the viewport comes back padded with grey
  bars, so this backend cannot use the layout-split zoom. Its output is therefore only as legible
  as a 1:1 render — verified in `research/probes/screencast-sizing/`, which is why that probe
  exists.

### Why it is kept at all

The plan (§17, §38) asks for the alternatives to be benchmarked rather than argued about, and a
benchmark needs both implementations. It is what lets the next person check the audit's
conclusion instead of taking it on faith — and it is how the table above was discovered.

## P2 — Camera system

Plan §14 (`camera.zoomTo`, `camera.panTo`, `camera.follow`). Not started. The frame-pipeline
architecture makes this substantially easier than it would be on a screencast, because a camera
move is a transform on an already-captured frame and needs no re-architecture.

---

## P3 — Declarative video format

Plan §16 (YAML/JSON video definitions). Not started. Blocked on a stable action set, which the
runtime now has. `autovideo inspect` is a natural precursor: it already walks a script without
running it.

---

## ~~P4 — Port the the application workflow~~ DONE (selectors verified; render needs credentials)

**Status:** ported to `a worked example/`. All 22 selectors verified against the app's
source. A real render needs a running app, live market data and a signed-in session, none of
which exist in this environment — so the port is verified structurally rather than by producing
a video.

### What the port proves

The framework has **no the application knowledge in it**. Every test id, indicator name and route
lives in `a worked example/selectors.ts`, which imports nothing from `autovideo`. That file is
the only thing that would change to retarget the script.

What the original did by hand and the port now gets for free:

| original                                                         | port                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------- |
| `mouse.move()` before every click, hoping a screencast caught it | `cursor.moveTo` — composited and interpolated           |
| `centerOn` + a hand-rolled easing loop                           | `scrollTo(sel, { behavior: 'natural' })`                |
| `settle(page, 'long')` — a 1300ms `setTimeout`                   | `pause(1300)` — exactly 39 frames at 30fps, any machine |
| manual screenshot + page HTML on failure                         | screenshot, trace, console, network, manifest           |
| `PRIVACY_CSS` hardcoded into the engine                          | `browser.extraCss` in the script                        |
| a persistent Chrome profile holding live session cookies         | `storageState`; contents never read                     |

### How it is verified

`a worked example/verify-selectors.mjs` reads every `.tsx` in the app and asserts each
selector the port uses still exists. A renamed `data-testid` fails there rather than three scenes
into a fifteen-minute render. All 22 pass.

`autovideo inspect a worked example/stock-overview.ts` walks it — 56 operations, 6 scenes,
~26.6s — without launching a browser.

### Still open

Rendering it for real needs `PRODUCT_URL`, market data and a `storageState` file. Worth doing
once by hand against the dev server; the remaining five templates (`why_stock_down`, `technical_
analysis`, `trendline`, `indicator_explainer`, `stock_vs_market`) would follow the same shape.

## ~~P5 — Element highlighting~~ DONE

`video.highlight(selector, options?)` and `video.clearHighlight()`. Amber ring, translucent fill,
configurable colour, width, radius and padding, with an optional self-clearing `durationMs`.

### The part that was not straightforward

The obvious implementation injects the overlay once, at the element's box at that moment, and it
drifts the moment the page moves — which in these videos it constantly does, because scrolling is
the main camera operation. A highlight that slides off the thing it highlights is worse than none.

So the overlay holds no geometry. Every frame it re-reads `getBoundingClientRect()` inside the
page and paints there. Scrolling, reflow and layout animations are handled for free, because the
measurement is against live layout rather than a remembered one. The tests exist to stop that
being quietly optimised back into a one-time measurement.

The fade is likewise sampled in Node from logical time rather than run as a CSS transition: a
transition animates in wall-clock time inside the browser and would fade differently on a slower
machine, which is precisely the non-determinism the logical clock exists to remove. A scale
animation would also have perturbed the ring's own measured geometry.

### Verified

- 15 overlay tests against a real page, including the two that matter most: the ring follows a
  scroll, and it follows reflow.
- 6 end-to-end renders, including a two-run determinism check on frames and duration.
- 7 unit tests on the fade sampler, including a fade-out overlapping a fade-in (which must
  multiply, or the ring inverts through zero and blinks) and a zero fade (which must not divide by
  zero into a NaN opacity).
- `examples/highlight/highlight.ts` walks under `inspect`: 17 operations, 4 scenes.

### A bug worth recording

The first implementation wrote `ring.style.border = 3px solid "#ffb020"` — the colour interpolated
into a page script unquoted, which is a JavaScript _syntax error_, not a wrong colour. It was
swallowed by the surrounding `.catch()` that exists to tolerate a destroyed execution context, so
the ring silently never appeared and every test failed with a bare `false`. Interpolated values
crossing into page context are quoted whole, and the comments there say why.

## P6 — Parallel rendering

Plan §2 P1.10 and §27. Each render is already independent — own scratch directory, own output
path, own debug stamp — so this should be a scheduling change rather than a design change.
Untested at present: nothing in the suite runs two renders concurrently.
