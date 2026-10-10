import { describe, expect, it } from 'vitest';

import { resolveConfig } from '../../src/config/config.js';
import {
  BASE_CHROMIUM_ARGS,
  buildContextOptions,
  buildLaunchOptions,
} from '../../src/browser/session.js';
import { buildStyling, HIDE_AUTOMATION_FLAGS_SCRIPT } from '../../src/browser/determinism.js';

describe('buildLaunchOptions', () => {
  it('produces exactly one args array', () => {
    // The reference implementation spread a stealth `args` and then declared a second `args`
    // later in the same object literal. The later key silently wins, so its own stealth flags
    // were discarded and nobody noticed for months. A single merged array cannot have that bug.
    const options = buildLaunchOptions(resolveConfig());
    expect(options.args).toBeDefined();
    expect(Array.isArray(options.args)).toBe(true);
  });

  it('includes every base switch', () => {
    const args = buildLaunchOptions(resolveConfig()).args ?? [];
    for (const flag of BASE_CHROMIUM_ARGS) {
      expect(args).toContain(flag);
    }
  });

  it('disables background throttling, without which rAF crawls in a headless window', () => {
    // This is the single most important switch in the list. Chromium treats a headless render
    // window as backgrounded and throttles timers, which stretches every animation.
    const args = buildLaunchOptions(resolveConfig()).args ?? [];
    expect(args).toContain('--disable-background-timer-throttling');
    expect(args).toContain('--disable-backgrounding-occluded-windows');
    expect(args).toContain('--disable-renderer-backgrounding');
  });

  it('pins the colour profile so pixels do not depend on the display', () => {
    expect(buildLaunchOptions(resolveConfig()).args).toContain('--force-color-profile=srgb');
  });

  it('appends caller args without dropping the base ones', () => {
    const args =
      buildLaunchOptions(resolveConfig({ browser: { args: ['--proxy-server=localhost:9'] } }))
        .args ?? [];

    expect(args).toContain('--proxy-server=localhost:9');
    expect(args).toContain('--hide-scrollbars');
  });

  it('adds the stealth switch only when asked', () => {
    const plain = buildLaunchOptions(resolveConfig()).args ?? [];
    const stealth = buildLaunchOptions(resolveConfig({ browser: { hideAutomationFlags: true } }));

    expect(plain).not.toContain('--disable-blink-features=AutomationControlled');
    expect(stealth.args).toContain('--disable-blink-features=AutomationControlled');
    expect(stealth.ignoreDefaultArgs).toEqual(['--enable-automation']);
  });

  it('honours headless and executablePath', () => {
    const headed = buildLaunchOptions(resolveConfig({ browser: { headless: false } }));
    expect(headed.headless).toBe(false);

    const custom = buildLaunchOptions(
      resolveConfig({ browser: { executablePath: '/opt/chrome' } }),
    );
    expect(custom.executablePath).toBe('/opt/chrome');
  });

  it('omits executablePath entirely when unset', () => {
    // Passing `executablePath: undefined` makes Playwright fall back, but an explicit key is
    // easier to trip over later.
    expect('executablePath' in buildLaunchOptions(resolveConfig())).toBe(false);
  });

  it('does not mutate the shared base list', () => {
    const before = [...BASE_CHROMIUM_ARGS];
    buildLaunchOptions(resolveConfig({ browser: { args: ['--x'], hideAutomationFlags: true } }));
    expect([...BASE_CHROMIUM_ARGS]).toEqual(before);
  });
});

describe('buildContextOptions', () => {
  it('uses the layout viewport, not the output viewport', () => {
    // Capturing at output size and downscaling is what the reference implementation learned not
    // to do; and legibility is the whole point of the layout split.
    const options = buildContextOptions(resolveConfig({ viewport: 'vertical' }));
    expect(options.viewport).toEqual({ width: 540, height: 960 });
  });

  it('tracks the viewport preset', () => {
    expect(buildContextOptions(resolveConfig({ viewport: 'landscape' })).viewport).toEqual({
      width: 960,
      height: 540,
    });
  });

  it('passes storageState through when configured', () => {
    const options = buildContextOptions(
      resolveConfig({ browser: { storageState: './auth.json' } }),
    );
    expect(options.storageState).toBe('./auth.json');
  });

  it('omits storageState entirely when unset', () => {
    expect('storageState' in buildContextOptions(resolveConfig())).toBe(false);
  });

  it('reduces motion by default and disables downloads', () => {
    const options = buildContextOptions(resolveConfig());
    expect(options.reducedMotion).toBe('reduce');
    expect(options.acceptDownloads).toBe(false);
  });

  it('allows motion and colour scheme to be turned off', () => {
    // `null` means "leave the browser default alone" and must survive config resolution. An
    // earlier version used `??`, which cannot distinguish `null` from "not provided", so
    // passing null silently kept the default and these settings could never be disabled.
    const config = resolveConfig({ browser: { reducedMotion: null, colorScheme: null } });
    expect(config.browser.reducedMotion).toBeNull();
    expect(config.browser.colorScheme).toBeNull();

    const options = buildContextOptions(config);
    expect(options.reducedMotion).toBeUndefined();
    expect(options.colorScheme).toBeUndefined();
  });

  it('omits optional context keys rather than passing undefined', () => {
    const options = buildContextOptions(resolveConfig({ browser: { colorScheme: null } }));
    expect('colorScheme' in options).toBe(false);
  });
});

describe('determinism stylesheet', () => {
  it('suppresses animations and transitions', () => {
    const css = buildStyling();
    expect(css).toContain('animation-duration: 0s');
    expect(css).toContain('transition-duration: 0s');
  });

  it('hides the caret, the most obvious source of pixel nondeterminism', () => {
    expect(buildStyling()).toContain('caret-color: transparent');
  });

  it('disables smooth scrolling so the scroll engine is the only thing moving the page', () => {
    expect(buildStyling()).toContain('scroll-behavior: auto');
  });

  it('excludes the framework overlay from suppression', () => {
    // The cursor overlay is positioned every frame by the framework. A blanket
    // `transition-duration: 0s` would freeze it in place.
    const css = buildStyling();
    expect(css).toContain('data-autovideo');
    expect(css).toContain(':not([data-autovideo])');
  });

  it('appends caller redaction CSS', () => {
    const css = buildStyling({ extraCss: ['.user-email { display: none !important; }'] });
    expect(css).toContain('.user-email');
  });

  it('ships no app-specific selectors of its own', () => {
    // The reference implementation hardcoded `.user-email` and two data-testid values here,
    // which is what made it un-reusable as a framework.
    const css = buildStyling();
    expect(css).not.toContain('data-testid');
    expect(css).not.toContain('recharts');
    expect(css).not.toMatch(/\.[a-z-]+-(section|panel|module)/i);
  });

  it('ignores blank extra CSS entries', () => {
    const css = buildStyling({ extraCss: ['', '   ', '\n'] });
    expect(css).not.toContain('undefined');
  });
});

describe('automation-flag script', () => {
  it('is a string, not a function', () => {
    // The TypeScript runner rewrites named functions with a `__name` helper that does not exist
    // in the page. Passed as a function it throws — and for init scripts it throws *silently*,
    // so the marker stays and every caller believes it was removed.
    expect(typeof HIDE_AUTOMATION_FLAGS_SCRIPT).toBe('string');
  });

  it('defines navigator.webdriver as undefined', () => {
    expect(HIDE_AUTOMATION_FLAGS_SCRIPT).toContain('navigator');
    expect(HIDE_AUTOMATION_FLAGS_SCRIPT).toContain('webdriver');
  });
});
