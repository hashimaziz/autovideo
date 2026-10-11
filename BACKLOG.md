# Backlog

Known issues and unfinished work, newest first. Each entry says what is observed, what has been
ruled out, and what the next step is — so nobody has to re-derive it.

---

## P0 — Intermittent frame-pump hang

**Status:** open. Mitigated but not root-caused.

### Symptom

Running `tests/integration/video.test.ts` repeatedly, roughly **1 run in 9** writes zero or one
frame and then produces none for 30 seconds, until the clock's stall guard fires:

```
Video time stopped advancing at 0ms while waiting for 1000ms.
No frames were produced for 30000ms.
```

A successful run of the same file takes ~70s; a failing one takes ~30s per stalled test. The
failure rate moved from roughly 1-in-2 to roughly 1-in-9 over the course of the investigation,
so it is a race, not a deterministic bug.

### Established

- `Page.captureScreenshot` does not **fail** during a navigation — it **hangs indefinitely**.
  Measured directly with a `Promise.race`, not inferred.
- `page.evaluate` has the same exposure, via the same underlying reason.
- The pump and the user's script drive the same page concurrently, so `open()` can begin a
  navigation while the pump is already inside a page call. Checking for an in-flight navigation
  _before_ each call is not sufficient: the navigation can start _during_ the call.

### Mitigations already in place

| Change                                           | Effect                                               |
| ------------------------------------------------ | ---------------------------------------------------- |
| Event-driven `#awaitNavigationSettled()`         | No page calls during a known navigation              |
| `PageGate` with navigation priority              | Serialises page access between pump and script       |
| Per-frame deadline (`FRAME_TIMEOUT_MS`)          | A stuck frame is dropped, not fatal                  |
| `encoder.write()` raced against `encoder.done`   | An encoder that stops consuming cannot hang the pump |
| Pump loop exit rejects pending waits immediately | No 30s mystery hang                                  |

Dropping a timed-out frame is deterministic by construction: logical time does not advance for a
frame that was not captured, so the video loses one frame of duration and nothing else.

### PageGate is defective — fix or remove it first

A full unit suite for `PageGate` was written and **all hand-off behaviour fails**:
one `release()` resolves **two** waiters, priority is not honoured, and
`withLock` does not serialise concurrent bodies.

`release()` splices exactly one waiter and resolves exactly one promise, so
the observed behaviour cannot be explained by the code as written. Either the
queue is being mutated somewhere unaccounted for, or the promise-per-waiter
wiring in `#enqueue` is not what it appears to be. **This was not resolved.**

The tests were removed rather than committed red. The implementation is still
in the render path, because it measurably reduces the failure rate — but it
should be treated as untrusted: it under-serialises, which means two holders
can hold the gate at once and the mutual exclusion it was written to provide
does not actually hold.

**Do not build on `PageGate` until it is fixed.** Either correct it with the
unit suite restored, or remove it and re-measure the failure rate without it.

### Next steps

1. **Rewrite `PageGate` from scratch against a unit suite**, committed alongside it. The
   simplest correct version is a promise chain rather than an explicit queue:
   each acquirer awaits the previous holder's release promise, and a timed-out
   acquirer simply stops awaiting. That removes the entire class of "cancelled
   waiter became a ghost owner" bug rather than patching around it.
2. **Instrument for a hang, properly.** Ad-hoc `process.stderr.write` misled me: stderr to a pipe
   is asynchronous in Node and reorders lines. Use `fs.writeSync` to a file, or wrap the pending
   operation in a `Promise.race` that records where it is still awaiting after N seconds.
3. Re-run `video.test.ts` in a loop (10+ iterations) to confirm the rate moved.

### Note on the flakiness being intermittent

Do not "fix" this by making a test skip the affected path. A test that passes because it avoided
a race is exactly the failure mode this project has been careful to reject elsewhere — two green
tests were already found passing for the wrong reason during Phase 1.

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
