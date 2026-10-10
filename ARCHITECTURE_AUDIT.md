# Architecture Audit — An Existing Video Automation Setup

**Status:** complete. No code from it has been modified.
**Scope:** read-only inspection of an existing standalone video-automation package, plus two empirical probes
run against Playwright 1.63 / Chromium 1243 on this machine.
**Purpose:** decide what to keep, rewrite, or discard before building the framework
(plan §4, §38, Phase 0).

---

## 1. Summary

The existing implementation is a **mature, app-specific video generator** that solves a large
part of what the framework wants to solve. It is not a framework: every selector, wait, and
narrative beat is hard-coded to one specific Next.js app, and it has no notion of a public
API, seeded randomness, or a logical clock.

Three conclusions drove the architecture of this repository:

1. **Do not refactor it into a package.** The reusable ideas are conceptual (scroll-container
   detection, landing verification, the run-failure contract), not structural. What survives is
   re-expressed against a proper abstraction; what does not is deleted.
2. **Its recording method is structurally wrong for this framework.** Playwright's
   `recordVideo` cannot render a cursor and cannot produce frame-deterministic output — both
   verified empirically in §5. This is the load-bearing finding of the audit.
3. **Its best engineering is in the failure and diagnostics paths, not the happy path.** The
   "a failed run must not leave something that looks like a finished video" invariant is the
   single most valuable idea in the codebase and is preserved verbatim in spirit.

---

## 2. What exists

### 2.1 Location and packaging

All video automation lives in **one standalone npm package** —
entirely outside the web app it records.

- **Not committed.** `.gitignore` excludes `video-automation/`. It is untracked local tooling.
- **A corrupted sibling project contains no video automation at all.** No Playwright, no ffmpeg,
  no `data-testid` attributes. It is an older snapshot of the same Next.js app and was
  discarded from consideration.
- The target application is a Next.js 14.2 App Router, React 18.2,
  Tailwind 3.4, Recharts 2.10, Firebase 12, Stripe 14, with **75 `data-testid` attributes
  across 15 files**.

### 2.2 Stack

| Concern | Choice |
|---|---|
| Runtime | Node ≥ 20, ESM (`"type": "module"`) |
| Language | TypeScript 5.7, `strict` + `noUnusedLocals` + `noUncheckedIndexedAccess` |
| Runner | `tsx` (esbuild-based) |
| Browser | `playwright` ^1.63, Chromium |
| Encoder | `ffmpeg-static` ^5.2 (bundled binary; nothing system-wide required) |
| Config | `dotenv`, a product-specific env prefix, zero hard-coded URLs |

### 2.3 Module inventory

| File | LOC | Role |
|---|---:|---|
| `src/cli.ts` | 364 | CLI: `--list`, `--doctor`, `--login`, `--all`, flag parsing |
| `src/config.ts` | 125 | env config, viewport parsing, `DESKTOP_VIEWPORT` |
| `src/types.ts` | 77 | manifest action/run types, `Timing` |
| `src/smoke.ts` | 70 | no-auth pipeline self-test against the public landing page |
| `src/dev-audit.ts` | 142 | selector audit against public `/demo` (dev-only, no npm script) |
| `src/lib/browser.ts` | 151 | launch + `recordVideo` + stealth |
| `src/lib/recording.ts` | 263 | run lifecycle, output paths, failure contract, diagnostics |
| `src/lib/ffmpeg.ts` | 127 | WebM → MP4 conversion, scale, probe |
| `src/lib/scrolling.ts` | 374 | scroll-container detection, animated scroll, centring |
| `src/lib/interact.ts` | 182 | mouse moves, clicks, typing helpers, `settle()` |
| `src/lib/waits.ts` | 136 | state-based waits |
| `src/lib/navigation.ts` | 199 | goto, enter ticker, analyse ticker, timeframes, chart options |
| `src/lib/selectors.ts` | 117 | `TID`, `INDICATOR`, `GUIDE_ANCHOR`, `APP_PATHS` |
| `src/lib/determinism.ts` | 117 | injected CSS, `hideAutomationFlags`, `assertAppReachable` |
| `src/lib/auth.ts` | 153 | persistent-profile sign-in + subscription check |
| `src/lib/manifest.ts` | 90 | action accumulator + JSON writer |
| `src/lib/errors.ts` | 24 | `RecordingError` |
| `src/lib/runner.ts` | — | subscription pre-flight |
| `src/templates/*.ts` | ~700 | 6 video templates + shared beats |

**Existing evidence of it working:** 18 successful videos in `output/{AAPL,NVDA,TSLA}/<6
templates>/<runId>/video.mp4`, 2.1–8.4 MB each, each with `manifest.json` + `metadata.json`.
Zero failed runs retained.

---

## 3. The 20-point inspection (plan §4)

**1. Playwright initialization.** `chromium.launchPersistentContext(userDataDir, …)` at
`src/lib/browser.ts:63`. Not `browser.newContext` — a persistent profile is what allows a real
Google session to survive between runs.

**2. Context/page configuration.** `reducedMotion: 'reduce'`, `colorScheme: 'dark'`,
`ignoreHTTPSErrors: true`, `acceptDownloads: false`, `--hide-scrollbars`, `--mute-audio`,
`--no-first-run`. Page timeouts: 20 s action / 45 s navigation.

**3. Vertical viewport.** Two viewports, not one — see §4.1. Layout 540×960 CSS, output
1080×1920.

**4–5. Recording method.** **Playwright's built-in `recordVideo`**, then one ffmpeg pass. Not
screenshot stitching, not CDP screencast.

**6. Screenshots.** Captured separately, and **only on failure** (see §13).

**7. Scrolling.** `src/lib/scrolling.ts` — the single most valuable generic module in the
codebase. Runtime scroll-container detection (the app sets `html, body { height: 100% }`,
which makes *body* the scroller and turns `window.scrollTo()` into a no-op), then frame-by-frame
easing with `easeInOutCubic`.

**8. Typing.** `input.pressSequentially(ticker, { delay: 90 })` in `src/lib/navigation.ts:39`,
with an explicit comment that this is used *instead of* `fill()` precisely so the recording shows
the symbol appearing. No humanisation layer, and no typos.

**9. Cursor behaviour.** `src/lib/interact.ts` — `moveTo(locator, steps = 16)` calls
`page.mouse.move(x, y, { steps })` before every interaction, because Playwright's default
`click()` teleports the cursor, which "reads as a glitch in a recording". Also `clickAt()` for
fractional chart coordinates, `parkCursorAbovePlot()`, `blurActiveElement()`.

**10. Waits/delays.** Strictly split: `src/lib/waits.ts` is state-based only
(`waitForFunction`, `requireVisible`, `requireHidden`); `src/lib/interact.ts` `settle()` is
pacing only, with a four-tier vocabulary (`settle` 400 ms, `short` 600, `normal` 1300,
`long` 2200).

**11. Video assembly.** `toMp4()` in `src/lib/ffmpeg.ts:47` — `scale` to target with Lanczos,
`libx264 -preset slow -crf 20 -pix_fmt yuv420p -r 30`, `-an`, `-movflags +faststart`. No audio.
Output profile is exactly what Reels/TikTok/Shorts accept without re-encode.

**12. FFmpeg.** Already involved, as an npm dependency (`ffmpeg-static`), with an
`FFMPEG_PATH` env fallback.

**13. Failure handling.** See §6. Strong, but the error type carries only `(step, message, hint)`.

**14. Output naming.** `output/<TICKER>/<template>/<runId>/` where
`runId = new Date().toISOString().replace(/[:.]/g, '-')`. Never overwritten.

**15. URL/configuration.** 100% env-driven under a product-specific prefix. `assertAppReachable()` runs a
`fetch` with a 10 s `AbortSignal` *before* launching Chromium, turning an opaque
connection-refused into an actionable message.

**16. Authentication.** Persistent Chrome profile at `video-automation/.auth/`, **not**
`storageState`. Playwright cannot complete Google OAuth unattended, so `npm run login` opens a
headed window and polls for up to 5 minutes. **This directory holds live session cookies and is
never to be copied or committed.**

**17. Dynamic application state.** Heavily. The app is a Next.js dashboard rendering Recharts
plots and signal cards from client-side fetches; `waits.ts` blocks on `>= 8` signal cards and on
`svg .recharts-curve` existing.

**18–20.** Application-specific, generic, and discard — see §5 and §7.

---

## 4. What is genuinely good

### 4.1 The layout-viewport / output-scale split

The single most transferable design decision in the codebase, documented at length in the
original README and `config.ts:64-93`.

> Playwright's video screencast records in **CSS pixels and only ever scales down**. Requesting a
> 1080×1920 video from a 540×960 viewport pads the frame with grey bars rather than enlarging it.
> `deviceScaleFactor` is ignored by the screencast entirely. The 2× enlargement therefore happens
> in ffmpeg, with a Lanczos filter, after capture.

The rationale is *not* primarily speed — it is that laying out at 1080 CSS px makes dashboard
text ~1.3% of frame width: technically correct, practically unreadable on a phone. A side
benefit is that at 540 px the app's own `≤768px` mobile breakpoint applies.

Measured on this machine (see §5.3), the split is also worth **1.2–1.9× end-to-end throughput**,
because encoding is resolution-bound while capture is not.

### 4.2 `centerOn` landing verification (`scrolling.ts:243`)

```ts
const first = await centerOnce(locator, target, durationMs);
if (first.landed) return;
const fresh = await scrollTarget(page);            // exactly one retry
const second = await centerOnce(locator, fresh, durationMs);
if (second.landed) return;
throw new RecordingError('scroll', `Scrolled to ${second.targetY}px but the target element is
still off-screen.`, 'The scroll target was probably mis-derived for this page layout.');
```

A mis-derived scroll target silently scrolls to the wrong place, or clamps to the end of the
page, and the recording still *looks plausible*. Verifying the element actually landed, with one
bounded retry for settling layout, converts a silent-wrong-output failure into a loud one. This
is the best idea in the codebase and is preserved.

### 4.3 The `getBoundingClientRect()` double-counting fix (`scrolling.ts:231`)

`getBoundingClientRect().top` is **viewport**-relative — it already has the current scroll offset
subtracted. Adding the `offsetTop` chain on top double-counts, which sent every target past the
end of the page and clamped it to the scroll limit. Absolute position is
`rect.top + <current offset of whichever element scrolls>`. Documented in place.

### 4.4 The run-failure contract (`recording.ts:181-227`)

> A failed run must not leave something that looks like a finished video.

```ts
await manifest.write(paths.manifestPath, { status: 'failed', failure: {…} });
await rm(paths.videoPath, { force: true });   // explicit safety delete
```

Plus: the manifest is constructed so it can still be written **if the browser never launched**,
and every diagnostics call is `.catch(() => undefined)` so diagnostics never mask the original
error.

### 4.5 The manifest accumulator (`manifest.ts`)

`mark({ name, note, selector, visibleText })` stamps each beat with elapsed time so a downstream
narration agent can line up a sentence with what is on screen. A genuinely useful output contract
that has nothing to do with the application. The existing 18 manifests show this working in practice.

### 4.6 `installPageStyling` is deliberately not memoised (`determinism.ts:58`)

A module-level "already applied" cache silently skipped the stylesheet on the recording page,
because the auth pre-flight had already claimed it. Each page gets its own handler. A good
comment on a real bug that would be easy to reintroduce.

---

## 5. Empirical findings

Two probes were run rather than trusting either the docs or the existing code. Raw artefacts are
in the commit that introduced this document's reproduction steps; both are reproducible with the
scripts described below.

### 5.1 Playwright's screencast does not render the cursor

**Probe.** A local HTTP page with two labelled boxes. The mouse was swept across the frame in 25
discrete `page.mouse.move()` steps spanning the `TARGET` box, then pressed and released. The
WebM was extracted and single frames pulled out at indices 30/40/50 and inspected visually.

**Result.** The page content renders correctly at the expected 540×960, and the mouse is
demonstrably over drawn content — **but no cursor appears anywhere in any extracted frame.**

This is decisive for the plan's §38 question. A framework whose stated goal is "cursor movement
and visibility as a first-class video concept" (§2 P0.8) cannot build its default recording path
on a backend that cannot draw a cursor.

> Reproduction: `probe2.mjs` in the commit history — launch with `recordVideo`, sweep the mouse,
> `saveAs`, then `ffmpeg -i probe.webm -vf select='eq(n\,40)' -frames:v 1 -update 1 frame.png`.

### 5.2 The screencast is wall-clock, not frame-deterministic

The same probe reports `Duration: 00:00:02.40` and `25 fps / 25 tbr` for a script whose actual
browser interaction was ~1.9 s. Frame timing is whatever the compositor happened to emit, and it
includes the teardown tail — which is why `recording.ts:136` must trim with `-t <duration>` and
why the original comments mention a "frozen teardown tail measured up to ~3.6s".

The plan requires determinism (§3.2, §18). A wall-clock screencast gives approximate
determinism at best: re-running the same script produces a video of the same *shape*, not the
same *frames*.

### 5.3 Capture and encode throughput

Sustained loop of 60 frames, capture → ffmpeg stdin → H.264 MP4. Reproduce with
`research/probes/screencast-cursor/frame-pipeline-throughput.mjs`.

| Layout → output | Capture only | Capture + encode |
|---|---|---|
| 540×960 → 1080×1920 (Lanczos) | 16.5 ms/frame (60 fps) | **18.4 ms/frame (54 fps)** — stable across 3 runs |
| 1080×1920 native | 16.5–20.0 ms/frame (50–61 fps) | 21.9–35.3 ms/frame (28–46 fps) — variable |

Two things follow:

- **Capture is resolution-independent** (~16–20 ms, i.e. one compositor frame) and is not the
  bottleneck.
- **Encoding is resolution-bound, and the native-1080 path is noisy.** The layout-split figure was
  identical to 0.1 ms across three runs; the native figure swung between 22 and 35 ms, presumably
  on x264 thread scheduling. So capturing at layout resolution is worth somewhere between
  **1.2× and 1.9×** end-to-end, and is *never worse* — which is the property that matters, given
  the plan's demand for reproducible render times.

At 54 fps of pipeline throughput, a 10-second 30 fps video renders in **~5.6 s**, and a
10-second 60 fps video in ~11 s. The plan's §27 target of "10-second video < 30 seconds render
time" is met with large headroom — **without** needing the wall-clock screencast at all.

### 5.4 An ffmpeg input-decoder gotcha

`-f image2pipe -c:v jpeg -i pipe:0` fails with `Unknown decoder 'jpeg'`. The correct values are
`-c:v mjpeg` (JPEG) and `-c:v png` (PNG). Getting this wrong kills ffmpeg immediately, which
closes stdin, which deadlocks any `await once('drain')` backpressure loop. Worth a comment in
the encoder module.

---

## 6. Defects found in the existing implementation

Not inherited by the framework. Listed because two are subtle enough to be reintroduced.

1. **Duplicate `args` key — stealth flags silently discarded** (`browser.ts:69-105`). The object
   literal spreads a stealth `args` array at line 72 and then declares a *second* `args` at line
   98. The later key wins, so `--disable-features=IsolateOrigins,site-per-process` is lost. Only
   `--disable-blink-features=AutomationControlled` survives, because it is re-appended at line
   104. TypeScript does not flag duplicate keys here.

2. **Dead `ffprobe` code** (`ffmpeg.ts:100-127`). `ffmpeg-static` ships only `ffmpeg`.
   `probeDurationSeconds()` derives an ffprobe path by regex-rewriting the ffmpeg path and
   `existsSync`-checks it, so it always returns `null`. It is never called. `fromHere()` is also
   exported and never used.

3. **`installPageStyling` vs. `hideAutomationFlags` ordering is load-bearing but undocumented
   at the call site** — init scripts registered after a page has loaded never fire.

4. **esbuild `__name` portability trap.** Named functions passed to `page.evaluate` are
   rewritten with a `__name` helper that does not exist in the page, so they throw and — via a
   `.catch` — *silently* report success. This constraint is documented in three places in
   `scrolling.ts` and `determinism.ts`, but it is a property of the *runner*, not the code. A
   different TS runner could invalidate the reasoning.

---

## 7. Reuse assessment

| Component | Reusable? | Verdict |
|---|---|---|
| `browser.ts` launch/teardown ordering | High | **Rewrite** — split `recordVideo` out; fix duplicate `args` |
| Layout-viewport / output-scale split | High | **Keep concept**, re-express as `layoutScale` config |
| `ffmpeg.ts` conversion | High | **Rewrite** — new pipe-based encoder; drop dead ffprobe |
| `scrolling.ts` container detection | High | **Rewrite** — already runtime-detected and app-agnostic |
| `scrolling.ts` frame-driven easing | High | **Rewrite** — logic moves into the motion track |
| `scrolling.ts` `centerOn` verification | High | **Keep semantics**, simplify to one pass |
| `scrolling.ts` `centerInScrollContainer` | High | **Keep** — genuinely needed for modal content |
| `scrolling.ts` `getBoundingClientRect` fix | High | **Keep** — port the comment with it |
| `interact.ts` move-before-click | High | **Keep** — becomes the cursor system's job |
| `interact.ts` `settle()` + 4-tier `Timing` | High | **Keep** — good pacing vocabulary |
| `interact.ts` `readText` / `describe` | High | **Keep** |
| `recording.ts` run lifecycle + output layout | High | **Keep**, parameterise the path scheme |
| `recording.ts` failure contract | High | **Keep** — strongest invariant in the codebase |
| `recording.ts` diagnostics capture | High | **Keep**, extend with trace/console/network |
| `errors.ts` `RecordingError` | High | **Extend** — needs scene/action/selector/url/elapsed |
| `manifest.ts` accumulator | High | **Keep** — best output contract here |
| `types.ts` | High | **Keep** |
| CLI scaffolding, flags, `--doctor` | High | **Keep**, rename env prefix |
| `smoke.ts` harness | High | **Keep as pattern** — retarget at the fixture app |
| `dev-audit.ts` selector audit | Medium | **Keep as pattern**, body is app-specific |
| `config.ts` | Medium | **Rewrite** — env prefix + app name only |
| `determinism.ts` `DETERMINISM_CSS` | Medium | **Split** — keep generic half; `.recharts-*` is vendor-specific |
| `determinism.ts` `PRIVACY_CSS` | Low | **Rewrite** — config-injected `extraCss` |
| `determinism.ts` `hideAutomationFlags` | Medium | **Keep** — needed for any anti-bot target |
| `determinism.ts` `assertAppReachable` | High | **Keep** — generalise the message |
| `auth.ts` Google OAuth | Low | **Rewrite** — `storageState` is the portable primitive |
| `assertHasSubscription` | None | **Discard** — billing concept |
| `selectors.ts`, `navigation.ts`, `waits.ts` | None | **Rewrite** — 100% app-specific |
| `templates/*` (6 files) | None | **Rewrite** — become examples, not framework code |
| `runner.ts` subscription pre-flight | Medium | **Keep the two-tier pattern**, drop the check |
| `.auth/` Chrome profile | **None** | **Never copy** — live session credentials |
| `output/` (18 videos) | None | **Discard** — app-specific artefacts |
| `README.md` (429 lines) | High | **Keep as pattern** — documentation quality bar |

**Net:** roughly 12 concepts carry over, 6 are rewritten with the *idea* preserved but the
structure changed, and everything touching selectors, templates, billing, or Google OAuth is
discarded. The application-specific layer becomes a worked example in Phase 7, which is
also how plan §40's "app-specific assumptions are not required by the framework" gets
proven rather than asserted.

---

## 8. The answer to plan §38

> **What is the best way to capture a real Chromium application while retaining enough control
> over cursor, motion, timing, and camera behaviour to produce deterministic video?**

**A deterministic frame pipeline driven by a logical clock. Not Playwright's screencast.**

The screencast fails on two of the five named requirements, verified in §5:

| Requirement | `recordVideo` | Frame pipeline |
|---|---|---|
| Cursor control | **impossible** — never drawn (§5.1) | composited by the framework |
| Deterministic frames | **no** — wall-clock screencast (§5.2) | frame index derived from logical time |
| Motion timing | coupled to compositor | actions register sampled animations |
| Camera / zoom | impossible | free — a transform on the captured frame |
| Throughput | real-time-ish, unpredictable | 54 fps measured, ~1.8× real-time at 30 fps output (§5.3) |

Design:

```
script → actions mutate state → ┌─────────────────────────┐
                                 │ FramePump (async loop)   │
                                 │  for each frame index:   │
                                 │   1. sample MotionTrack  │
                                 │   2. apply to page       │
                                 │   3. capture via CDP     │
                                 │   4. write to ffmpeg     │
                                 └─────────────────────────┘
```

- Frame index derives from a **logical clock**, never from screencast arrival.
- Motion is `Animation = { startMs, durationMs, sample(t) → state }` on a `MotionTrack`. Actions
  register one and await its completion; the pump samples it every frame. Easing becomes a
  *sampling* problem rather than a `mouse.move(steps)` problem.
- The pump runs concurrently with whatever the script is awaiting, so `pause(1000)` genuinely
  emits 60 frames of a static page.
- `recordVideo` is retained as an opt-in `"fast"` backend for throwaway previews, where
  approximate timing is acceptable and a cursor is not needed.

**The cursor is rendered into the page as a DOM overlay**, positioned imperatively each frame
rather than by a CSS animation. This avoids an image-compositing dependency, scales correctly
with the layout viewport, and stays deterministic because *we* set the transform. The real
Playwright mouse still moves underneath so hover and click hit-testing remain genuine — which is
exactly the separation plan §12 asks for between browser mouse position and video cursor
representation. `cursor.mode: "native"` switches to driving the real mouse with a minimal
in-page cursor.

---

## 9. Recommended migration path

Phase order is unchanged from the plan; this audit only settles *what* Phase 1 is built from.

1. **Foundation first, no Playwright.** Seeded PRNG, config validation, logical clock, scene
   tracking, easing, motion track. All pure and all unit-testable — the determinism guarantees
   live here, and they are worthless if they cannot be tested without a browser.
2. **Encoder.** Pipe-based ffmpeg sink, unit-tested by encoding synthetic frames.
3. **Frame pump.** Browser-dependent, but testable against a local fixture app.
4. **Actions and cursor** on top of the pump.
5. **Facade, manifest, errors, diagnostics.**
6. **CLI, then examples, then a worked port of a real workflow.**

Porting order from the old code, when each module is written: `errors` → `types` → `manifest` →
`determinism` (generic half only) → `ffmpeg` (rewritten for pipes) → `scrolling` → `interact` →
`browser` (without `recordVideo`) → `recording`.

### Things to do differently from the start

- No `Math.random()` anywhere (plan §19). Every natural behaviour draws from a seeded stream.
- No named functions passed to `page.evaluate` (§6.4) — enforced by a lint rule, not a comment.
- Single `args` array, built by one function, merged explicitly.
- No `ffprobe` dependency.
- Auth via `storageState`, not a persistent profile.

### Security posture carried forward (plan §28)

- The framework executes arbitrary user scripts by default. This must be documented prominently.
- Manifests must never contain tokens, cookies, or `storageState` contents.
- `extraCss` is the supported redaction hook (hide personal modules) rather than app-specific CSS
  baked into the engine.
- `.auth/`-equivalent directories are documented as credential-bearing and gitignored.