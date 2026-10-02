import { describe, expect, it } from 'vitest';
import { describeNpc } from '@renderer/office/anim/npcs';
import type { FigureController, FigurePhase } from '@renderer/office/anim/figureController';
import type { Activity } from '@shared/activity';

/** Just the three things the description actually reads. */
function someone(phase: FigurePhase, seated: number, carry: number): FigureController {
  return {
    phase,
    pose: () => ({ seated, carry }),
  } as unknown as FigureController;
}

function said(activity: Activity, phase: FigurePhase, seated = 0, carry = 0, voice = 0): string {
  return describeNpc({ controller: someone(phase, seated, carry), activity, voice });
}

describe('what a caretaker says they are doing', () => {
  it('tells you rather than apologising', () => {
    // The card used to lead with "not one of your sessions, and not doing
    // anything on your behalf" — true, and an apology rather than an answer.
    const line = said('reading', 'standing', 1);
    expect(line.length).toBeGreaterThan(4);
    expect(line.toLowerCase()).not.toContain('not one of');
  });

  it('distinguishes going, doing and settled', () => {
    const going = said('reading', 'walking');
    const there = said('reading', 'standing', 0);
    const settled = said('reading', 'standing', 1);
    // Three states, because that is the difference the animation already draws
    // and the card was throwing away.
    expect(new Set([going, there, settled]).size).toBe(3);
    expect(going.toLowerCase()).toMatch(/off|heading/);
  });

  it('notices full hands before anything else', () => {
    expect(said('idle', 'walking', 0, 1)).toBe('Carrying a coffee back');
    expect(said('messaging', 'walking', 0, 1)).toBe('Carrying a parcel from the mailroom');
    // And sitting with one is its own thing, not "standing about in the lounge".
    expect(said('idle', 'standing', 1, 1)).toBe('Sitting with a coffee');
  });

  it('says the same thing every time you point at the same person', () => {
    // Voice is fixed per caretaker, so the wording does not shuffle while the
    // card is open — which would read as the app being unsure.
    for (const voice of [0, 1, 7, 996]) {
      expect(said('idle', 'standing', 1, 0, voice)).toBe(said('idle', 'standing', 1, 0, voice));
    }
    const a = said('idle', 'standing', 1, 0, 0);
    const b = said('idle', 'standing', 1, 0, 1);
    expect(a).not.toBe(b); // but two different people may differ
  });

  it('always has something to say, for every errand there is', () => {
    const every: Activity[] = [
      'idle', 'reading', 'searching', 'delegating', 'running', 'testing',
      'browsing', 'messaging', 'publishing', 'watching', 'compacting', 'thinking',
    ];
    for (const activity of every) {
      for (const phase of ['walking', 'standing'] as FigurePhase[]) {
        const line = said(activity, phase, phase === 'standing' ? 1 : 0);
        expect(line, `${activity}/${phase}`).toBeTruthy();
        expect(line.trim()).toBe(line);
      }
    }
  });
});
