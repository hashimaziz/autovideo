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

## P1 — Screencast backend declared but not implemented

`recorder.backend: 'screencast'` is accepted and validated, and the CLI exposes `--fast`, but
there is no code path behind it. Plan §17 asks for Playwright-screencast capture to be
_benchmarked_ against the frame pipeline before choosing one, and `ARCHITECTURE_AUDIT.md` §8
argues the frame pipeline should win. The audit's conclusion has not yet been confirmed by
measurement.

**Next step:** implement it behind the existing switch, benchmark both on the same script, and
record the results in the README. Until then, `--fast` silently does nothing, which is worse
than not offering it — remove the flag or implement it.

---

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

## P4 — Port the the application workflow

Plan §39 step 11 and §40's "the application-specific assumptions are not required by the framework".
Not started. The audit identified exactly what is generic (scroll-container detection, landing
verification, the run-failure contract, the manifest) and what must be rewritten (all selectors,
templates, Recharts-specific waits, Google OAuth). This is the test of whether the framework is
genuinely reusable rather than merely refactored.

---

## P5 — Element highlighting

Plan §2 P1.3. Straightforward given the CSS injection mechanism already in `browser/determinism.ts`,
but it is an app-facing feature rather than a rendering primitive, so it belongs after the engine
is solid.

---

## P6 — Parallel rendering

Plan §2 P1.10 and §27. Each render is already independent — own scratch directory, own output
path, own debug stamp — so this should be a scheduling change rather than a design change.
Untested at present: nothing in the suite runs two renders concurrently.
