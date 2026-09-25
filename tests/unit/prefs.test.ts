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
    const merged = mergePrefs({ groups: 'nope', mode: 'simulation', office: null });
    expect(merged.groups).toEqual([]);
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

  it('replaces scalars and arrays outright', () => {
    const next = applyPatch(DEFAULT_PREFS, {
      hideSdkSessions: false,
      groups: [{ id: 'g1', name: 'Olympix', colorIndex: 2, members: ['1@2'] }],
    });
    expect(next.hideSdkSessions).toBe(false);
    expect(next.groups).toHaveLength(1);

    const cleared = applyPatch(next, { groups: [] });
    expect(cleared.groups).toEqual([]);
  });

  it('does not let a patch leave the version behind', () => {
    const next = applyPatch({ ...DEFAULT_PREFS, version: 0 }, { motion: 'reduced' });
    expect(next.version).toBe(PREFS_VERSION);
  });

  it('never shares mutable state with the defaults', () => {
    const a = mergePrefs(null);
    a.office.deskCells['x'] = [1, 2];
    expect(mergePrefs(null).office.deskCells).toEqual({});
    expect(DEFAULT_PREFS.office.deskCells).toEqual({});
  });
});
