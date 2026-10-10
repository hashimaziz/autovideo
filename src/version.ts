/**
 * Framework version, recorded in every run manifest.
 *
 * Determinism is only meaningful relative to a known build. A manifest that says
 * "seed 42069 produced this video" is useless without also saying which version of the
 * engine, which browser, and which ffmpeg produced it — the plan requires all three (§18).
 *
 * Kept as a literal rather than read from package.json so it survives bundling and is
 * available before any filesystem access. `npm run build` does not rewrite it; bumping the
 * version here and in package.json together is the contract.
 */
export const VERSION = '0.1.0';

/** Semantic-version shape, asserted by the unit suite so this cannot drift silently. */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
