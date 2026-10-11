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
  as a 1:1 render — verified in [`ARCHITECTURE.md`](ARCHITECTURE.md) §3, which is why that probe
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

## ~~P4 — Port a real production workflow~~ DONE (later moved out of this repo)

A full production workflow was ported onto the public API as the framework's acid test: that an
existing workflow can be reproduced with no application-specific assumptions in the engine, where
every selector lives in one file that imports nothing from `autovideo`.

That claim was verified three ways: a selector audit that fails when the app renames a `data-testid`;
`inspect` walking the script without launching a browser; and finally a real render against the
running application with a signed-in session.

The port itself now lives in the application repo, where the application knowledge belongs. What
stayed here is what it taught, and §7 and §8 of [`ARCHITECTURE.md`](ARCHITECTURE.md).

Two bugs were found only by rendering for real, neither reachable from a fixture — a pre-filled
input that made `type()` produce `AAPL` + `AAPL`, and a page that scrolls its `BODY`, which
exposed two disagreeing definitions of the scrolling element and meant every scripted scroll clamped
to zero. See §8.

The remaining five workflows of the same application are unported.

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

## ~~P6 — Parallel rendering~~ DONE (a real bug, not a scheduling change)

The note here called it "a scheduling change rather than a design change". That was optimistic, and
the way it was found was by running three renders at once rather than by reading the code.

Each render did have its own scratch _file_ — named from the pid and a timestamp, so no two files
collided. But they shared a scratch _directory_, `<outputDir>/.scratch`, and cleanup removed that
directory **recursively**. So a run that finished first deleted the in-flight scratch file of a run
that had not, and the second died at the final rename:

    ENOENT: no such file or directory, rename '.../.scratch/render-11828-...mp4' -> '.../p3.mp4'

which names neither the cause nor the run that caused it. Three parallel renders failed roughly
half the time, depending on which finished first.

Each run now takes its own `mkdtemp` directory beneath the shared root, so cleanup can only ever
remove its own. The root is created before `mkdtemp`, which needs it to exist.

### Verified

Five integration tests, all with runs genuinely overlapping in one output directory:

- three concurrent renders all produce files, and nothing else appears;
- two concurrent renders agree on frames and duration — concurrency must not leak into the output;
- the per-run scratch directories are gone afterwards, so a long batch cannot fill the disk;
- each run's manifest stays separate;
- **one concurrent run failing still leaves its neighbours' output intact** — the case the old
  recursive delete made worst, since a failure path cleans up too.

303 unit tests, 142 integration tests.

## P7 — Suppressing elements by name

Plan §2 P1.4. Today the only way to keep personal data out of a video is `browser.extraCss`, which
takes a raw selector. That works, but it puts the knowledge in the wrong place: the caller has to
know a CSS selector for the thing they want hidden, which means reading the app's markup to find
out what it calls the user's email.

The ask: a `setup()` that takes plain names — `['user-email', 'portfolio-section', 'account-id']`
— and finds and hides those elements itself, however that is best implemented.

Design is open. Some things worth deciding:

- **By `data-testid` first, then by class, then by visible text?** A name lookup that tries a few
  strategies would work against most apps without a per-app config, but a text match risks hiding
  the wrong thing when several elements share a name.
- **Hide, or remove?** `display: none` is reversible and keeps layout stable; removing from the DOM
  is unambiguous but can break the app's own scripts mid-render.
- **Should a name that matches nothing be an error?** Silently matching nothing is how sensitive
  data ends up in a published video, so a warning — or a failure under a strict flag — is probably
  the safer default.
- **Does it compose with `extraCss`?** It should, rather than replace it: `extraCss` is the escape
  hatch for anything the name lookup cannot express.

Worth noting this is a problem people solve by hand today — passing CSS for the user's email, a
portfolio section and a watchlist section in `extraCss`, precisely because there is no name-based
way to say it. Any real application with user data is the test case.

## P8 — One definition of the scrolling element (fixed, found by rendering for real)

Not a planned item. Found by rendering against a real application and then reading the frames,
which is a humbling way to find a bug the tests had been unable to see.

`measureElementScript` and `RESOLVE_SCROLLER_SCRIPT` disagreed about which element scrolls. Every
other part of `scrolling.ts` checked BODY first; measurement used `document.scrollingElement`, which
reports HTML even on a page that scrolls its BODY — common in apps that pin a header.

Because measurement is what computes how far to scroll, the centring offset came back wrong by
exactly the current scroll position, and — since HTML's scroll limit there is zero — every scripted
scroll clamped to zero. No error, no warning: the render "succeeded" and the video sat at the top of
a 4500px dashboard for its last sixteen seconds while the script recorded scrolls that had not
happened.

One rule now, two call sites. Four regression tests on a fixture that scrolls its BODY, including
the assertion the old code failed: that the element ends up _centred_, not merely reachable.

The lesson is in the test rather than the fix. Asserting "the scroll happened" is what the suite
did before, and on a document-scrolling page that passes while the underlying rule is wrong.
