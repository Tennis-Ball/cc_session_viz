import { describe, expect, it } from 'vitest';
import { applyPatch, DEFAULT_PREFS, mergePrefs, PREFS_VERSION } from '@shared/prefs';

describe('prefs', () => {
  it('starts from defaults when there is nothing on disk', () => {
    expect(mergePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(mergePrefs('not json')).toEqual(DEFAULT_PREFS);
    expect(mergePrefs(42)).toEqual(DEFAULT_PREFS);
  });

  it('fills in what an older file is missing', () => {
    const old = { version: 0, theme: { office: 'sage' } };
    const merged = mergePrefs(old);
    expect(merged.theme.office).toBe('sage');
    expect(merged.theme.canvas).toBe(DEFAULT_PREFS.theme.canvas);
    expect(merged.sound).toEqual(DEFAULT_PREFS.sound);
    expect(merged.version).toBe(PREFS_VERSION);
  });

  it('survives a file with the wrong types in it', () => {
    const merged = mergePrefs({ hideSdkSessions: 'nope', mode: 'simulation', office: null });
    expect(merged.hideSdkSessions).toBe('nope');
    expect(merged.mode).toBe('simulation');
    expect(merged.office.deskCells).toEqual({});
  });

  it('only ever reads back a mode it knows', () => {
    // An older file, or a hand-edited one, must not put the engine in a state
    // that is neither real nor simulated.
    expect(mergePrefs({ mode: 'always' }).mode).toBe('real');
    expect(mergePrefs({ mode: null }).mode).toBe('real');
    expect(mergePrefs({ mode: 'simulation' }).mode).toBe('simulation');
  });

  it('patches one field without clearing its neighbours', () => {
    const next = applyPatch(DEFAULT_PREFS, { theme: { office: 'ink' } });
    expect(next.theme.office).toBe('ink');
    expect(next.theme.canvas).toBe(DEFAULT_PREFS.theme.canvas);
    expect(next.theme.pinnedClock).toBeNull();
    expect(next.sound).toEqual(DEFAULT_PREFS.sound);
  });

  it('replaces scalars outright', () => {
    const next = applyPatch(DEFAULT_PREFS, { hideSdkSessions: false, endedGraceMs: 60_000 });
    expect(next.hideSdkSessions).toBe(false);
    expect(next.endedGraceMs).toBe(60_000);
  });

  /*
   * Version 4 dropped `groups`, `canvas.sizes` and `canvas.offsets`: nothing
   * created the first and nothing read the other two. A file carrying them
   * has to come back clean rather than smuggling them forward.
   */
  it('drops keys the app no longer has code for', () => {
    const merged = mergePrefs({
      version: 4,
      groups: [{ id: 'g1', name: 'Olympix', colorIndex: 2, members: ['1@2'] }],
      canvas: { sizes: { 'a': [1, 2] }, offsets: { 'a': [3, 4] } },
      motion: 'reduced',
      theme: { office: 'sage' },
    });
    expect('groups' in merged).toBe(false);
    expect('canvas' in merged).toBe(false);
    // Version 5 drops `motion` too: reduced motion follows the system now, and
    // an app-level override for it was only ever a way to disagree with macOS.
    expect('motion' in merged).toBe(false);
    expect(merged.theme.office).toBe('sage');
    expect(merged.version).toBe(PREFS_VERSION);
  });

  it('does not let a patch leave the version behind', () => {
    const next = applyPatch({ ...DEFAULT_PREFS, version: 0 }, { hideSdkSessions: false });
    expect(next.version).toBe(PREFS_VERSION);
  });

  it('never shares mutable state with the defaults', () => {
    const a = mergePrefs(null);
    a.office.deskCells['x'] = [1, 2];
    expect(mergePrefs(null).office.deskCells).toEqual({});
    expect(DEFAULT_PREFS.office.deskCells).toEqual({});
  });
});

describe('retired settings', () => {
  it('drops the sound switches the app no longer has', () => {
    // An early build had per-category effects — room tone, key clicks, machine
    // noise, chimes — and then the office decided it was quiet. Spreading the
    // stored object carried all four forward on every write, so prefs files
    // still listed switches nothing had read in months. A settings file is a
    // promise about what the app does.
    const merged = mergePrefs({
      version: 5,
      sound: { enabled: true, master: 0.3, roomTone: true, keys: true, machines: false, chimes: true },
    });
    expect(merged.sound).toEqual({ enabled: true, master: 0.3 });
    expect(Object.keys(merged.sound)).toEqual(['enabled', 'master']);
  });

  it('keeps the volume inside the range a gain node will take', () => {
    expect(mergePrefs({ version: 5, sound: { master: 4 } } as never).sound.master).toBe(1);
    expect(mergePrefs({ version: 5, sound: { master: -2 } } as never).sound.master).toBe(0);
    expect(mergePrefs({ version: 5, sound: { master: 'loud' } } as never).sound.master).toBe(
      DEFAULT_PREFS.sound.master,
    );
  });
});

describe('what a patch may put into a running app', () => {
  it('cleans a retired value on the way in, not only on the way off disk', () => {
    /*
     * The loader was the only thing that checked a setting, and a patch is not
     * a load. `office.detail: 'composed'` was retired two rounds before a test
     * stopped setting it, and until it was cleaned on write it went straight
     * through `applyPatch` into every renderer, where the table it indexes
     * came back undefined and the office died mid-render. A restart fixed it,
     * because the file *was* sanitised on the next read — which is why it took
     * a screenshot of a crash panel to notice at all.
     */
    const patched = mergePrefs(applyPatch(DEFAULT_PREFS, { office: { detail: 'composed' as never } }));
    expect(patched.office.detail).toBe(DEFAULT_PREFS.office.detail);
  });

  it('cleans every enumerated setting a patch can carry', () => {
    const wild = mergePrefs(
      applyPatch(DEFAULT_PREFS, {
        office: { detail: 'lavish' as never, weather: 'hail' as never, horizon: 'mountains' as never },
        mode: 'guesswork' as never,
        sound: { master: 9 } as never,
      }),
    );
    expect(wild.office.detail).toBe(DEFAULT_PREFS.office.detail);
    expect(wild.office.weather).toBe(DEFAULT_PREFS.office.weather);
    expect(wild.office.horizon).toBe(DEFAULT_PREFS.office.horizon);
    expect(wild.mode).toBe('real');
    expect(wild.sound.master).toBe(1);
  });

  it('still lets a patch through when it is one the app has', () => {
    const kept = mergePrefs(applyPatch(DEFAULT_PREFS, { office: { detail: 'quiet' } }));
    expect(kept.office.detail).toBe('quiet');
    expect(kept.version).toBe(PREFS_VERSION);
  });
});
