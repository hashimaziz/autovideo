# autovideo-port — the stock overview workflow, rebuilt on autovideo

A real production video workflow, rebuilt on autovideo's public API.

This is the test of the framework's central claim: that this workflow can be reproduced using only
the public API, with **no application-specific assumptions in the engine**. It lives in this repo
because that is where it belongs — the selectors are application knowledge, and autovideo knows
none of it.

It replaces the older `video-automation` implementation, which drove Playwright directly. See
[Why the rewrite](#why-the-rewrite) below for what that bought.

## Files

| file                                           | what it is                                          |
| ---------------------------------------------- | --------------------------------------------------- |
| [`selectors.ts`](selectors.ts)                 | Every piece of app-specific knowledge, in one place |
| [`stock-overview.ts`](stock-overview.ts)       | The port of the original `stock_overview` template  |
| [`verify-selectors.mjs`](verify-selectors.mjs) | Checks every selector against the app's source      |

## Running it

```sh
# 1. Start the app
cd ../web && npm run dev

# 2. Record a sign-in session (see "Authentication" below)
npx playwright codegen --save-storage=storage-state.json http://localhost:3000/login
#    …sign in by hand, then close the browser.

# 3. Render
SIMPLYSTOCK_URL=http://localhost:3000 \
SIMPLYSTOCK_STORAGE_STATE=./storage-state.json \
SIMPLYSTOCK_OUTPUT=./output/AAPL.mp4 \
  npx autovideo render autovideo-port/stock-overview.ts
```

Requires `autovideo` installed (`npm i -D autovideo`) and a Chromium for it
(`npx playwright install chromium`). Run `npx autovideo doctor` to check.

Environment variables: `SIMPLYSTOCK_URL`, `SIMPLYSTOCK_TICKER` (default `AAPL`),
`SIMPLYSTOCK_PERIOD` (default `3mo`), `SIMPLYSTOCK_STORAGE_STATE`.

To check the script's structure without rendering anything:

```sh
SIMPLYSTOCK_URL=http://localhost:3000 autovideo inspect autovideo-port/stock-overview.ts
```

## What the port demonstrates

The previous implementation was ~120 lines of Playwright helpers across eight modules, plus a
template. This is one script calling only public API. What used to be manual work is now the
framework's job:

| original                                                         | port                                           | what changed                                                                                                               |
| ---------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `mouse.move()` before every click, hoping a screencast caught it | `video.cursor.moveTo(selector)`                | The screencast **never drew a cursor** — the audit proved it. Here it is composited and interpolated.                      |
| `centerOn()` + a hand-rolled `easeInOutCubic` loop               | `video.scrollTo(sel, { behavior: 'natural' })` | Also verifies the element actually landed, instead of reporting success for a mis-derived target.                          |
| `settle(page, 'long')` — a 1300 ms `setTimeout`                  | `video.pause(1300)`                            | Renders exactly 39 frames at 30fps on any machine. A machine-dependent pause makes renders differ.                         |
| Manual screenshot + page HTML on failure                         | Nothing                                        | A failure writes a screenshot, a Playwright trace, console and network logs, and a manifest naming the scene and selector. |
| `PRIVACY_CSS` hardcoded into the engine                          | `browser.extraCss` in the script               | The framework ships **no** app selectors. Redaction is configuration.                                                      |
| Custom `RecordingError` per helper                               | `VideoRenderError`                             | Scene, action, selector, URL, elapsed time, artefact paths.                                                                |

## What did not change

The app knowledge. Selector strings, indicator names and routes are still required, because no
framework can guess what an application calls its own DOM.

That knowledge lives **entirely** in `selectors.ts`, which imports nothing from `autovideo`.
Retargeting this script to another application means editing that one file.

## Verification

The port cannot run in CI — it needs a running app, live market data and a signed-in session. What
_can_ be checked is the part most likely to rot:

```sh
SIMPLYSTOCK_WEB=../web node autovideo-port/verify-selectors.mjs
```

This reads every `.tsx` file in the app and asserts each `data-testid` the port depends on still
exists. A selector renamed in the app fails here rather than three scenes deep into a
fifteen-minute render. All 22 selectors are currently present.

## Authentication

The original used `chromium.launchPersistentContext()` pointing at a directory holding a **live
signed-in Chrome profile**, because Google OAuth cannot be completed unattended.

This port uses Playwright's `storageState` instead, which is the portable primitive. The framework
records the _path_ in the manifest and never reads the _contents_, so session cookies cannot leak
into a manifest or a debug artefact.

The original's `.auth/` directory is a credential-bearing profile and is never copied or
committed here. `.gitignore` already excludes `.auth/` and `storage-state*.json` for exactly that
reason.

## Note on `/demo`

SimplyStock has a public `/demo` route, which is useful for unauthenticated selector auditing. It
carries **no `data-testid` attributes** — only class names — so the port deliberately targets the
real `/dashboard` rather than degrading to class selectors for a demo path.
