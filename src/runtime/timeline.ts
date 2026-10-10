/**
 * Scenes and the action timeline.
 *
 * A video is a sequence of scenes, and each scene is a sequence of actions with logical
 * timestamps. Recording that structure is not decoration — it is what makes a failed run
 * debuggable and what later lets scenes be edited, re-run in parallel, or handed to a narration
 * tool (plan §15).
 *
 * Everything here reads the {@link LogicalClock} for its timestamps, so a recorded timeline is
 * expressed in video time and is therefore reproducible: two runs of the same script record the
 * same action times regardless of how fast the machine was.
 */

import type { LogicalClock } from './clock.js';

/** A single action, as recorded on the timeline. */
export interface ActionRecord {
  /** Zero-based position across the whole video. */
  index: number;
  /** Machine name, e.g. `click` or `scrollTo`. Safe to branch on. */
  type: string;
  /** Logical start, in milliseconds. */
  startMs: number;
  /** Logical duration, in milliseconds. */
  durationMs: number;
  /** Logical end, in milliseconds. `startMs + durationMs`. */
  endMs: number;
  /** The scene this action belongs to, or null for actions outside any scene. */
  scene: string | null;
  /** Selector or other target, when the action had one. */
  target: string | undefined;
  /** Short verbatim text visible at this moment, when the action captured any. */
  visibleText: string | undefined;
  /** Free-form extras for callers that want to annotate their own beats. */
  metadata: Readonly<Record<string, unknown>>;
}

/** A named span of the video. */
export interface SceneRecord {
  name: string;
  /** Zero-based position. */
  index: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  actions: ActionRecord[];
  metadata: Readonly<Record<string, unknown>>;
}

/** What a caller hands to `timeline.record`. */
export interface ActionInput {
  type: string;
  target?: string;
  visibleText?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Accumulates scenes and actions while a render is in progress.
 *
 * Pure bookkeeping: it never awaits, never touches the browser, and never advances time. The only
 * clock interaction is reading `now()`.
 */
export class Timeline {
  readonly #clock: LogicalClock;

  readonly #scenes: SceneRecord[] = [];

  readonly #actions: ActionRecord[] = [];

  /** The scene currently being recorded, or null. */
  #openScene: SceneRecord | undefined;

  /** Arbitrary facts about the run itself, attached to the manifest at the end. */
  readonly #metadata = new Map<string, unknown>();

  constructor(clock: LogicalClock) {
    this.#clock = clock;
  }

  /** Current logical time, in milliseconds. */
  now(): number {
    return this.#clock.now();
  }

  /**
   * Record the start of an action.
   *
   * The returned finisher must be called exactly once; calling it twice throws rather than
   * pushing a duplicate record and corrupting every subsequent index. Any action left unfinished
   * when a run ends is closed by {@link Timeline.seal}.
   */
  begin(input: ActionInput): (extra?: { visibleText?: string }) => ActionRecord {
    const startMs = this.now();
    const index = this.#actions.length;
    const scene = this.#openScene?.name ?? null;

    let settled = false;

    return (extra = {}) => {
      // Guard against a double-finish, which would otherwise push two records for one action and
      // corrupt every subsequent index.
      if (settled) {
        throw new Error(
          `Action "${input.type}" was already finished. begin() returns a function that must be called once.`,
        );
      }
      settled = true;

      const endMs = this.now();
      const record: ActionRecord = {
        index,
        type: input.type,
        startMs,
        durationMs: Math.max(0, endMs - startMs),
        endMs,
        scene,
        target: input.target,
        visibleText: extra.visibleText ?? input.visibleText,
        metadata: input.metadata ?? {},
      };

      this.#actions.push(record);
      this.#openScene?.actions.push(record);

      return record;
    };
  }

  /** Record a zero-duration action, for beats that are worth marking but take no time. */
  mark(input: ActionInput): ActionRecord {
    return this.begin(input)();
  }

  /**
   * Run `body` as a named scene, closing it even if `body` throws.
   *
   * The scene is always recorded, including a failed one, because "which scene failed and how
   * far into it" is the first thing anyone wants to know about a broken render.
   */
  async scene<T>(
    name: string,
    body: () => Promise<T>,
    metadata?: Record<string, unknown>,
  ): Promise<T> {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('timeline.scene() requires a non-empty name.');
    }

    if (this.#openScene) {
      throw new Error(
        `Cannot open scene "${name}" while "${this.#openScene.name}" is still open. Scenes cannot nest.`,
      );
    }

    const record: SceneRecord = {
      name,
      index: this.#scenes.length,
      startMs: this.now(),
      endMs: this.now(),
      durationMs: 0,
      actions: [],
      metadata: metadata ?? {},
    };
    this.#scenes.push(record);
    this.#openScene = record;

    try {
      return await body();
    } finally {
      record.endMs = this.now();
      record.durationMs = Math.max(0, record.endMs - record.startMs);
      this.#openScene = undefined;
    }
  }

  /** Name of the scene currently open, or null. */
  currentScene(): string | null {
    return this.#openScene?.name ?? null;
  }

  /** Every scene, in order. */
  scenes(): readonly SceneRecord[] {
    return this.#scenes;
  }

  /** Every action, in order. */
  actions(): readonly ActionRecord[] {
    return this.#actions;
  }

  /** Total logical duration so far. */
  durationMs(): number {
    return this.#clock.now();
  }

  /** Look up a scene by name. */
  sceneNamed(name: string): SceneRecord | undefined {
    return this.#scenes.find((scene) => scene.name === name);
  }

  /** Actions belonging to a scene. */
  actionsIn(name: string): ActionRecord[] {
    return this.#actions.filter((action) => action.scene === name);
  }

  /** Attach a fact about the run, for the manifest. */
  set(key: string, value: unknown): void {
    this.#metadata.set(key, value);
  }

  /** Read a run fact previously attached with {@link Timeline.set}. */
  get<T = unknown>(key: string): T | undefined {
    return this.#metadata.get(key) as T | undefined;
  }

  /** Every run fact attached so far. */
  allMetadata(): Record<string, unknown> {
    return Object.fromEntries(this.#metadata);
  }

  /**
   * Close anything left open, and return a snapshot.
   *
   * Called at the end of a run so a scene interrupted by a throw is still reported with its real
   * start, and no action is left half-recorded.
   */
  seal(): { scenes: SceneRecord[]; actions: ActionRecord[]; durationMs: number } {
    if (this.#openScene) {
      this.#openScene.endMs = this.now();
      this.#openScene.durationMs = Math.max(0, this.#openScene.endMs - this.#openScene.startMs);
      this.#openScene = undefined;
    }

    return {
      scenes: this.#scenes.map((scene) => ({ ...scene, actions: [...scene.actions] })),
      actions: [...this.#actions],
      durationMs: this.now(),
    };
  }
}
