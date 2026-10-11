/**
 * A module with no default export, standing in for a script that drives itself.
 *
 * The runner decides whether it still has to create a video by checking whether a script exports
 * a function, so the detection needs a fixture on each side of that. This is the "no export" side.
 *
 * Importing a real self-driving script would *run* it — launching a browser and rendering — so the
 * suite uses this instead: it reproduces the shape without the cost. The side effect below is the
 * stand-in for the script having done its work at import time.
 */

(globalThis as Record<string, unknown>).__autovideoSelfDrivenFixtureRan = true;

export const ran = true;
