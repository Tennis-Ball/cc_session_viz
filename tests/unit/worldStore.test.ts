import { describe, expect, it } from 'vitest';
import { WorldStore } from '@engine/state/worldStore';
import type { AgentView, MessageLink, SessionView, WatchTask } from '@shared/model';

/**
 * "Real sessions, or the generated office. Never both."
 *
 * That was the design from the start, and for a long time it was true of every
 * caller's intentions and of none of the mechanism: both sources wrote into
 * one store, and the store took whatever it was handed. Three separate paths
 * could put a real session on screen while the simulation was running — the
 * burst before the remembered mode had been restored at launch, a filesystem
 * read already in flight when the live source was torn down, and the
 * transcript hub, which asked the live source first whatever the mode was.
 *
 * So the rule lives here now, and this is what holds it.
 */

function session(id: string, ambient: boolean): SessionView {
  return { ...({} as SessionView), id, ambient };
}

function agent(id: string, slotId: string, ambient: boolean): AgentView {
  return { ...({} as AgentView), id, slotId, ambient };
}

describe('a world shows one kind of session', () => {
  it('drops real sessions while simulating, and simulated ones while real', () => {
    const store = new WorldStore();

    store.setMode('simulation');
    store.upsertSession(session('real', false));
    store.upsertSession(session('fake', true));
    expect(Object.keys(store.snapshot().sessions)).toEqual(['fake']);

    store.setMode('real');
    store.upsertSession(session('real', false));
    store.upsertSession(session('fake2', true));
    expect(Object.keys(store.snapshot().sessions)).toEqual(['real']);
  });

  /**
   * The one that matters most: a switch has to take the previous world away,
   * not merely stop adding to it. This is the case the async teardown race
   * could never win on timing alone.
   */
  it('sweeps out whatever the other mode left behind when it switches', () => {
    const store = new WorldStore();
    store.upsertSession(session('real', false));
    store.upsertAgent(agent('a1', 'real', false));
    store.upsertWatch({ ...({} as WatchTask), id: 'w1', slotId: 'real' });
    expect(Object.keys(store.snapshot().sessions)).toHaveLength(1);

    store.setMode('simulation');
    expect(store.snapshot().sessions).toEqual({});
    expect(store.snapshot().agents).toEqual({});
    expect(store.snapshot().watches).toEqual({});
  });

  /** Things with no provenance of their own are judged by their session. */
  it('refuses a watch or a workflow whose session is not in this world', () => {
    const store = new WorldStore();
    store.setMode('simulation');
    store.upsertSession(session('fake', true));

    store.upsertWatch({ ...({} as WatchTask), id: 'mine', slotId: 'fake' });
    store.upsertWatch({ ...({} as WatchTask), id: 'theirs', slotId: 'real' });
    expect(Object.keys(store.snapshot().watches)).toEqual(['mine']);
  });

  it('refuses a message unless one of its ends is in this world', () => {
    const store = new WorldStore();
    store.setMode('simulation');
    store.upsertSession(session('fake', true));

    const link = (from: string, to: string): MessageLink =>
      ({ ...({} as MessageLink), from: { kind: 'session', slotId: from }, to: { kind: 'session', slotId: to } });

    store.appendLink(link('fake', 'real'));
    store.appendLink(link('real', 'other'));
    expect(store.snapshot().links).toHaveLength(1);
  });
});
