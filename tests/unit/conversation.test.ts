import { describe, expect, it } from 'vitest';
import { Conversations, type Talker } from '@renderer/office/anim/conversation';
import type { FigureController } from '@renderer/office/anim/figureController';

/** Just the parts a conversation reads and writes. */
function person(id: string, at: [number, number, number], phase = 'standing'): FigureController {
  const played: string[] = [];
  const faced: [number, number, number][] = [];
  const stub = {
    id,
    phase,
    position: at,
    played,
    faced,
    play: (kind: string) => played.push(kind),
    faceTowards: (point: [number, number, number]) => faced.push(point),
  };
  return stub as unknown as FigureController;
}

const beats = (c: FigureController): string[] => (c as unknown as { played: string[] }).played;
const looks = (c: FigureController): unknown[] => (c as unknown as { faced: unknown[] }).faced;

/**
 * Runs the clock a second at a time until somebody starts talking.
 *
 * Stopping the moment one begins, rather than running a fixed stretch: a
 * conversation lasts at most twenty-six seconds, so a loop long enough to make
 * one *certain* to start is also long enough for it to have finished by the
 * time the assertion runs.
 */
function settle(chats: Conversations, talkers: Talker[], seconds = 60, now = 1000): number {
  let clock = now;
  for (let i = 0; i < seconds; i += 1) {
    clock += 1000;
    chats.update(talkers, 1, clock);
    if (talkers.some((talker) => chats.talking(talker.controller.id))) break;
  }
  return clock;
}

describe('people stopping to talk', () => {
  it('pairs up two who are standing next to each other', () => {
    const a = person('a', [0, 0, 0]);
    const b = person('b', [1.4, 0, 0]);
    const pair: Talker[] = [
      { controller: a, idle: true },
      { controller: b, idle: true },
    ];
    const chats = new Conversations(7);
    let clock = settle(chats, pair);
    expect(chats.talking('a')).toBe(true);
    expect(chats.partner('a')).toBe('b');
    // Then let it run a few seconds, so there are turns to look at.
    for (let i = 0; i < 6; i += 1) chats.update(pair, 1, (clock += 1000));

    // They turn to each other, and take it in turns: one holds forth while the
    // other acknowledges, and both move on every turn — a listener standing
    // perfectly still reads as somebody who has stopped working, not as
    // somebody being talked to.
    expect(looks(a).length).toBeGreaterThan(0);
    expect(beats(a)).toContain('speak');
    expect(beats(a)).toContain('nod');
    expect(beats(b)).toContain('speak');
    expect(beats(a).every((kind) => kind === 'speak' || kind === 'nod')).toBe(true);
  });

  it('leaves people alone who are not near each other', () => {
    const a = person('a', [0, 0, 0]);
    const b = person('b', [9, 0, 0]);
    const chats = new Conversations(7);
    settle(chats, [
      { controller: a, idle: true },
      { controller: b, idle: true },
    ]);
    expect(chats.talking('a')).toBe(false);
  });

  it('does not stop somebody who has work to do', () => {
    /*
     * An agent mid-turn standing about chatting is the office saying something
     * untrue about the machine, which is the one thing it must never do.
     */
    const busy = person('agent', [0, 0, 0]);
    const idler = person('npc', [1.2, 0, 0]);
    const chats = new Conversations(7);
    settle(chats, [
      { controller: busy, idle: false },
      { controller: idler, idle: true },
    ]);
    expect(chats.talking('agent')).toBe(false);
    expect(chats.talking('npc')).toBe(false);
  });

  it('will not hold a conversation with the top of somebody\'s head', () => {
    // A terrace above reads as close under an isometric camera and is not.
    const below = person('a', [0, 0, 0]);
    const above = person('b', [1, 2.5, 0]);
    const chats = new Conversations(7);
    settle(chats, [
      { controller: below, idle: true },
      { controller: above, idle: true },
    ]);
    expect(chats.talking('a')).toBe(false);
  });

  it('breaks it off when one of them walks away', () => {
    const a = person('a', [0, 0, 0]);
    const b = person('b', [1.2, 0, 0]);
    const chats = new Conversations(7);
    const clock = settle(chats, [
      { controller: a, idle: true },
      { controller: b, idle: true },
    ]);
    expect(chats.talking('a')).toBe(true);

    (b as unknown as { position: number[] }).position = [7, 0, 0];
    chats.update(
      [
        { controller: a, idle: true },
        { controller: b, idle: true },
      ],
      1,
      clock + 1000,
    );
    expect(chats.talking('a')).toBe(false);
  });

  it('does not start the same conversation again the moment it ends', () => {
    /*
     * Without a cooling-off period the same two people, still standing beside
     * each other, begin again on the next tick — and what that draws is not a
     * conversation but a pair of figures nodding at each other for ever.
     */
    const a = person('a', [0, 0, 0]);
    const b = person('b', [1.2, 0, 0]);
    const pair: Talker[] = [
      { controller: a, idle: true },
      { controller: b, idle: true },
    ];
    const chats = new Conversations(3);
    let clock = settle(chats, pair);
    expect(chats.talking('a')).toBe(true);

    // Past the longest a conversation can run, so it has certainly ended.
    clock += 30_000;
    chats.update(pair, 1, clock);
    expect(chats.talking('a')).toBe(false);
    // And still quiet a few seconds later.
    chats.update(pair, 1, clock + 4000);
    expect(chats.talking('a')).toBe(false);
  });

  it('forgets everything when the campus is rebuilt under it', () => {
    const a = person('a', [0, 0, 0]);
    const b = person('b', [1.2, 0, 0]);
    const chats = new Conversations(7);
    settle(chats, [
      { controller: a, idle: true },
      { controller: b, idle: true },
    ]);
    chats.clear();
    expect(chats.talking('a')).toBe(false);
    expect(chats.partner('a')).toBe(null);
  });
});

describe('a conversation the world reported', () => {
  it('starts one on demand, names it as real, and ends any other', () => {
    const a = person('a', [0, 0, 0]);
    const b = person('b', [1.4, 0, 0]);
    const c = person('c', [1.0, 0, 1.0]);
    const three: Talker[] = [
      { controller: a, idle: true },
      { controller: b, idle: true },
      { controller: c, idle: true },
    ];
    const chats = new Conversations(7);
    const clock = settle(chats, three);
    expect(chats.talking('a')).toBe(true);
    // Whoever 'a' fell into conversation with, a message outranks it.
    expect(chats.reported('a')).toBe(false);

    chats.summon('a', 'c', clock + 1000);
    expect(chats.partner('a')).toBe('c');
    expect(chats.reported('a')).toBe(true);
    expect(chats.reported('c')).toBe(true);
    expect(chats.talking('b')).toBe(false);
  });

  it('extends the one already running rather than starting a second', () => {
    const a = person('a', [0, 0, 0]);
    const b = person('b', [1.4, 0, 0]);
    const chats = new Conversations(3);
    chats.summon('a', 'b', 1000);
    const partner = chats.partner('a');
    chats.summon('a', 'b', 4000);
    expect(chats.partner('a')).toBe(partner);
    expect(chats.partner('b')).toBe('a');
  });

  it('ignores the cooldown, because the message really did happen', () => {
    const a = person('a', [0, 0, 0]);
    const b = person('b', [1.4, 0, 0]);
    const pair: Talker[] = [
      { controller: a, idle: true },
      { controller: b, idle: true },
    ];
    const chats = new Conversations(11);
    chats.summon('a', 'b', 1000);
    // Run it right out, which puts both of them in cooldown.
    for (let i = 0; i < 20; i += 1) chats.update(pair, 1, 1000 + i * 1000);
    expect(chats.talking('a')).toBe(false);
    chats.summon('a', 'b', 40_000);
    expect(chats.talking('a')).toBe(true);
    expect(chats.reported('a')).toBe(true);
  });
});
