import { beforeEach, describe, expect, it } from 'vitest';

import { LogicalClock } from '../../src/runtime/clock.js';
import { Timeline } from '../../src/runtime/timeline.js';

/** Advance logical time, then let the waiting promise settle. */
async function tick(clock: LogicalClock, ms: number): Promise<void> {
  clock.advanceTo(clock.now() + ms);
  await Promise.resolve();
}

describe('action records', () => {
  let clock: LogicalClock;
  let timeline: Timeline;

  beforeEach(() => {
    clock = new LogicalClock();
    timeline = new Timeline(clock);
  });

  it('records a zero-duration action for a mark', () => {
    const record = timeline.mark({ type: 'beat', target: '#chart' });

    expect(record).toMatchObject({
      index: 0,
      type: 'beat',
      startMs: 0,
      endMs: 0,
      durationMs: 0,
      target: '#chart',
      scene: null,
    });
  });

  it('records start and end from logical time, not wall-clock time', async () => {
    const finish = timeline.begin({ type: 'click', target: '#search' });
    await tick(clock, 350);
    const record = finish();

    expect(record.startMs).toBe(0);
    expect(record.endMs).toBe(350);
    expect(record.durationMs).toBe(350);
  });

  it('numbers actions consecutively', () => {
    expect(timeline.mark({ type: 'a' }).index).toBe(0);
    expect(timeline.mark({ type: 'b' }).index).toBe(1);
    expect(timeline.mark({ type: 'c' }).index).toBe(2);
  });

  it('captures visible text supplied at finish time', async () => {
    const finish = timeline.begin({ type: 'click', target: '#ticker' });
    await tick(clock, 100);
    const record = finish({ visibleText: 'Overall Signal: HOLD' });

    expect(record.visibleText).toBe('Overall Signal: HOLD');
  });

  it('prefers finish-time visible text over begin-time', () => {
    const finish = timeline.begin({ type: 'click', visibleText: 'stale' });
    expect(finish({ visibleText: 'fresh' }).visibleText).toBe('fresh');
  });

  it('rejects a double finish rather than corrupting later indices', () => {
    // A duplicated record would shift every subsequent index and make the manifest wrong.
    const finish = timeline.begin({ type: 'click' });
    finish();

    expect(() => finish()).toThrow(/already finished/);
    expect(timeline.actions()).toHaveLength(1);
  });

  it('keeps caller metadata', () => {
    const record = timeline.mark({ type: 'scrollTo', metadata: { distance: 800 } });
    expect(record.metadata).toEqual({ distance: 800 });
  });
});

describe('scenes', () => {
  let clock: LogicalClock;
  let timeline: Timeline;

  beforeEach(() => {
    clock = new LogicalClock();
    timeline = new Timeline(clock);
  });

  it('records a scene span from logical time', async () => {
    await timeline.scene('intro', async () => {
      await tick(clock, 500);
      await tick(clock, 700);
    });

    const [scene] = timeline.scenes();
    expect(scene).toBeDefined();
    expect(scene).toMatchObject({
      name: 'intro',
      index: 0,
      startMs: 0,
      endMs: 1200,
      durationMs: 1200,
    });
    expect(scene?.actions).toHaveLength(0);
  });

  it('attaches actions to the scene they happened in', async () => {
    await timeline.scene('open', async () => {
      timeline.mark({ type: 'open', target: '/' });
      await tick(clock, 100);
      timeline.mark({ type: 'pause' });
    });
    await timeline.scene('search', async () => {
      timeline.mark({ type: 'click', target: '#search' });
    });

    expect(timeline.sceneNamed('open')?.actions.map((action) => action.type)).toEqual([
      'open',
      'pause',
    ]);
    expect(timeline.sceneNamed('search')?.actions.map((action) => action.type)).toEqual(['click']);
    expect(timeline.actionsIn('open')).toHaveLength(2);
    expect(timeline.actionsIn('search')).toHaveLength(1);
  });

  it('stamps each action with its scene name', async () => {
    await timeline.scene('analysis', async () => {
      timeline.mark({ type: 'scrollTo' });
    });

    expect(timeline.actions()[0]?.scene).toBe('analysis');
  });

  it('records actions outside any scene with a null scene', () => {
    expect(timeline.mark({ type: 'open' }).scene).toBeNull();
  });

  it('numbers scenes in order', async () => {
    await timeline.scene('one', async () => {});
    await timeline.scene('two', async () => {});

    expect(timeline.scenes().map((scene) => scene.index)).toEqual([0, 1]);
  });

  it('closes the scene and records a failure when the body throws', async () => {
    // "Which scene failed and how far into it" is the first thing anyone wants about a broken
    // render, so the scene must survive the throw.
    await expect(
      timeline.scene('analysis', async () => {
        await tick(clock, 300);
        timeline.mark({ type: 'scrollTo', target: '#chart' });
        throw new Error('selector not found');
      }),
    ).rejects.toThrow('selector not found');

    const [scene] = timeline.scenes();
    expect(scene).toBeDefined();
    expect(scene?.name).toBe('analysis');
    expect(scene?.endMs).toBe(300);
    expect(scene?.durationMs).toBe(300);
    expect(scene?.actions).toHaveLength(1);
    expect(timeline.currentScene()).toBeNull();
  });

  it('refuses to nest scenes', async () => {
    // Nesting would produce ambiguous timestamps and a scene tree the manifest cannot represent.
    await timeline.scene('outer', async () => {
      await expect(timeline.scene('inner', async () => {})).rejects.toThrow(/cannot nest/i);
    });
  });

  it('rejects an empty scene name', async () => {
    await expect(timeline.scene('', async () => {})).rejects.toThrow(TypeError);
  });

  it('exposes the open scene while running', async () => {
    expect(timeline.currentScene()).toBeNull();
    await timeline.scene('work', async () => {
      expect(timeline.currentScene()).toBe('work');
    });
    expect(timeline.currentScene()).toBeNull();
  });

  it('carries scene metadata', async () => {
    await timeline.scene('intro', async () => {}, { purpose: 'hook' });

    expect(timeline.sceneNamed('intro')?.metadata).toEqual({ purpose: 'hook' });
  });
});

describe('run metadata and seal', () => {
  let clock: LogicalClock;
  let timeline: Timeline;

  beforeEach(() => {
    clock = new LogicalClock();
    timeline = new Timeline(clock);
  });

  it('stores and reads run facts', () => {
    timeline.set('seed', 42069);
    timeline.set('url', 'https://example.com');

    expect(timeline.get<number>('seed')).toBe(42069);
    expect(timeline.get('url')).toBe('https://example.com');
    expect(timeline.get('missing')).toBeUndefined();
  });

  it('returns all run facts', () => {
    timeline.set('seed', 1);
    timeline.set('fps', 30);

    expect(timeline.allMetadata()).toEqual({ seed: 1, fps: 30 });
  });

  it('reports total duration from the clock', async () => {
    await tick(clock, 400);
    await tick(clock, 600);

    expect(timeline.durationMs()).toBe(1000);
  });

  it('seals into an immutable snapshot', async () => {
    await timeline.scene('one', async () => {
      timeline.mark({ type: 'open' });
    });

    const sealed = timeline.seal();

    expect(sealed.scenes).toHaveLength(1);
    expect(sealed.actions).toHaveLength(1);
    // Mutating the sealed copy must not corrupt the live timeline.
    sealed.scenes[0]!.name = 'mutated';
    expect(timeline.sceneNamed('one')?.name).toBe('one');
  });

  it('closes a scene left open by an abrupt exit', async () => {
    // seal() is what guarantees no scene is left unterminated, even if control never returned.
    await timeline.scene('interrupted', async () => {
      await tick(clock, 250);
    });

    const sealed = timeline.seal();
    expect(sealed.scenes[0]?.durationMs).toBe(250);
  });

  it('is safe to seal twice', async () => {
    await timeline.scene('one', async () => {});
    expect(() => timeline.seal()).not.toThrow();
    expect(() => timeline.seal()).not.toThrow();
  });
});

describe('timeline mirrors logical, not wall-clock, time', () => {
  it('records identical timings for the same sequence stepped differently', async () => {
    const run = async (steps: number[]) => {
      const clock = new LogicalClock();
      const timeline = new Timeline(clock);
      await timeline.scene('demo', async () => {
        const finish = timeline.begin({ type: 'click' });
        for (const step of steps) clock.advanceTo(clock.now() + step);
        finish();
        await tick(clock, 500);
      });
      return timeline.seal();
    };

    // One coarse jump versus five fine ones: same logical timeline.
    const coarse = await run([1000]);
    const fine = await run([200, 200, 200, 200, 200]);

    expect(coarse.durationMs).toBe(fine.durationMs);
    expect(coarse.actions[0]?.durationMs).toBe(fine.actions[0]?.durationMs);
    expect(coarse.scenes[0]?.durationMs).toBe(fine.scenes[0]?.durationMs);
  });
});
