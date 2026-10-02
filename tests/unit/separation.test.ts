import { describe, expect, it } from 'vitest';
import { separateFigures, type FigureController } from '@renderer/office/anim/figureController';

/**
 * Just the parts the separation pass reads and writes.
 *
 * A real controller needs a resolver, a campus and a nav graph to exist, and
 * none of that has anything to say about whether two bodies overlap. The pass
 * is deliberately written against this much of the interface so it can be
 * tested against exactly this much — and so the edge cases below can be set up
 * by hand rather than waited for.
 */
interface Stub {
  id: string;
  phase: string;
  position: [number, number, number];
  nudgeWanted: [number, number];
  scale: number;
  seated: boolean;
  heading: number;
  readonly bodyRadius: number;
  readonly standsAt: [number, number];
  readonly course: [number, number] | null;
  readonly isSeated: boolean;
  clearNudge(): void;
  pushAside(x: number, z: number): void;
}

/** What the pass is handed. The stub is the whole of what it touches. */
const crowd = (people: Stub[]): FigureController[] => people as unknown as FigureController[];

// Mirrors of the module's own constants: `pushAside`'s cap is the one piece of
// the controller the stub has to reproduce, because the cap is what decides
// whether a pair can part fully or only partly.
const GIVE = 0.32 * 2.02 * 1.12;
const BODY = 0.32;

function body(
  id: string,
  at: [number, number, number],
  options: { phase?: string; scale?: number; seated?: boolean; heading?: number } = {},
): Stub {
  const stub: Stub = {
    id,
    phase: options.phase ?? 'standing',
    position: at,
    nudgeWanted: [0, 0],
    scale: options.scale ?? 1,
    seated: options.seated ?? false,
    heading: options.heading ?? 0,
    get bodyRadius(): number {
      return BODY * stub.scale;
    },
    get standsAt(): [number, number] {
      return [stub.position[0] + stub.nudgeWanted[0], stub.position[2] + stub.nudgeWanted[1]];
    },
    get course(): [number, number] | null {
      return stub.phase === 'walking' ? [Math.sin(stub.heading), Math.cos(stub.heading)] : null;
    },
    get isSeated(): boolean {
      return stub.seated;
    },
    clearNudge(): void {
      stub.nudgeWanted = [0, 0];
    },
    pushAside(x: number, z: number): void {
      const wx = stub.nudgeWanted[0] + x;
      const wz = stub.nudgeWanted[1] + z;
      const reach = Math.hypot(wx, wz);
      const keep = reach > GIVE ? GIVE / reach : 1;
      stub.nudgeWanted = [wx * keep, wz * keep];
    },
  };
  return stub;
}

const give = (figure: Stub): number => Math.hypot(figure.nudgeWanted[0], figure.nudgeWanted[1]);
const apart = (a: Stub, b: Stub): number => Math.hypot(a.standsAt[0] - b.standsAt[0], a.standsAt[1] - b.standsAt[1]);

describe('keeping figures out of each other', () => {
  it('separates two standing in the same place by a whole body', () => {
    /*
     * The old pass could not do this, and that is the bug it shipped with: it
     * capped each figure's step at a third of a unit, so two bodies 0.88 across
     * were pushed to 0.68 apart and drawn inside each other for as long as they
     * both stood there. Half a fix is not one — and the second half was that the
     * body was measured at 0.44 against a cone of 0.3, so for a while "fully
     * apart" was a distance the cap could not reach however many passes it ran.
     */
    const a = body('a', [4, 0, 4]);
    const b = body('b', [4, 0, 4]);
    separateFigures(crowd([a, b]));
    expect(apart(a, b)).toBeGreaterThanOrEqual(a.bodyRadius + b.bodyRadius - 0.02);
  });

  it('untangles a knot of five, not just the nearest pair', () => {
    /*
     * One relaxation pass settles a pair and gets a crowd wrong: every push is
     * worked out against where everybody *started*, so three figures in a knot
     * all agree to move into the same gap and arrive on top of each other
     * again. This is the case that needs the passes.
     */
    const people = [
      body('a', [10, 0, 10]),
      body('b', [10.1, 0, 10.05]),
      body('c', [9.95, 0, 10.1]),
      body('d', [10.05, 0, 9.92]),
      body('e', [9.9, 0, 9.95]),
    ];
    separateFigures(crowd(people));
    for (let i = 0; i < people.length; i += 1) {
      for (let j = i + 1; j < people.length; j += 1) {
        // Not the full body — five people in one square metre cannot all have
        // one — but far enough that the crowd reads as a crowd and not as one
        // smeared figure.
        expect(apart(people[i]!, people[j]!), `${people[i]!.id}/${people[j]!.id}`).toBeGreaterThan(0.3);
      }
    }
  });

  it('steps a head-on pair aside rather than braking them', () => {
    /*
     * The one the office actually showed. Two figures meeting on a walkway were
     * pushed apart along the line between them, which on a head-on approach is
     * straight backwards along the way each is going: it slowed them down and
     * left them on the same line, so they walked through each other. People
     * sidestep. Each steps to its own right, which is opposite in world terms,
     * so the pair passes.
     */
    const a = body('a', [0, 0, 0], { phase: 'walking', heading: 0 }); // heading +z
    const b = body('b', [0, 0, 0.5], { phase: 'walking', heading: Math.PI }); // heading -z
    separateFigures(crowd([a, b]));

    // Sideways, not along the corridor: almost all of the step is in x.
    expect(Math.abs(a.nudgeWanted[0])).toBeGreaterThan(Math.abs(a.nudgeWanted[1]) * 3);
    expect(Math.abs(b.nudgeWanted[0])).toBeGreaterThan(Math.abs(b.nudgeWanted[1]) * 3);
    // And in opposite directions, so they actually pass each other.
    expect(Math.sign(a.nudgeWanted[0])).toBe(-Math.sign(b.nudgeWanted[0]));
  });

  it('leaves a seated figure in its chair', () => {
    // Shoving somebody out of their own seat to fix a moment of overlap is a
    // worse picture than the overlap. The passer-by takes the whole step.
    const sitting = body('a', [2, 0, 2], { seated: true });
    const passing = body('b', [2.2, 0, 2], { phase: 'walking', heading: Math.PI / 2 });
    separateFigures(crowd([sitting, passing]));
    expect(give(sitting)).toBe(0);
    expect(give(passing)).toBeGreaterThan(0.2);
  });

  it('makes the one who is walking go around the one who is not', () => {
    // Nobody standing still gets shuffled aside by somebody passing them: the
    // person going somewhere is the one who goes around. It is also twice the
    // clearance, because the walker takes the whole width of the nudge rather
    // than half of it, which is what the last deep overlap in the office was.
    const waiting = body('a', [2, 0, 2]);
    const passing = body('b', [2, 0, 2.8], { phase: 'walking', heading: Math.PI });
    separateFigures(crowd([waiting, passing]));
    expect(give(waiting)).toBe(0);
    expect(give(passing)).toBeGreaterThan(0);
  });

  it('gives a bigger figure a wider berth', () => {
    // Models come in four sizes — `scaleForTier`, 1.38 through 2.02. One reach
    // for all of them is too much room round a Haiku and not enough round a
    // Fable.
    const small = body('a', [0, 0, 0], { scale: 1.38 });
    const smaller = body('b', [0, 0, 0.5], { scale: 1.38 });
    separateFigures(crowd([small, smaller]));
    const tight = apart(small, smaller);

    const big = body('c', [0, 0, 0], { scale: 2.02 });
    const bigger = body('d', [0, 0, 0.5], { scale: 2.02 });
    separateFigures(crowd([big, bigger]));
    expect(apart(big, bigger)).toBeGreaterThan(tight);
  });

  it('ignores anybody a storey away', () => {
    // Two people either side of a terrace edge are nowhere near each other,
    // however close they look from an isometric camera.
    const above = body('a', [6, 2.5, 6]);
    const below = body('b', [6, 0, 6]);
    separateFigures(crowd([above, below]));
    expect(give(above)).toBe(0);
    expect(give(below)).toBe(0);
  });

  it('settles, rather than twitching between two answers', () => {
    // The pass runs every frame on the same crowd. If it does not land on the
    // same answer twice, what you see is a figure vibrating.
    const people = [body('a', [3, 0, 3]), body('b', [3.2, 0, 3.1]), body('c', [3.1, 0, 2.9])];
    separateFigures(crowd(people));
    const first = people.map((p) => [...p.nudgeWanted] as [number, number]);
    separateFigures(crowd(people));
    for (let i = 0; i < people.length; i += 1) {
      expect(people[i]!.nudgeWanted[0]).toBeCloseTo(first[i]![0], 6);
      expect(people[i]!.nudgeWanted[1]).toBeCloseTo(first[i]![1], 6);
    }
  });

  it('gives way before it has to, when the two of them are closing', () => {
    /*
     * The thing a per-frame overlap test cannot do on its own.
     *
     * Two figures walking at each other close a body's width in about a quarter
     * of a second, which is also how long the step aside takes to ease in — so
     * parting them at the moment they touch parts them after they have already
     * gone through each other. Measured over four minutes of a ten-session
     * office, this was fourteen pairs with one figure's centre inside another,
     * the worst of them standing in exactly the same place.
     */
    // Far enough apart that nothing is touching: two bodies at this size want
    // 0.64 between their centres, and the look-ahead reaches to about 1.09.
    const north = body('a', [0, 0, 0], { phase: 'walking', heading: 0 });
    const south = body('b', [0, 0, 0.9], { phase: 'walking', heading: Math.PI });
    separateFigures(crowd([north, south]));

    // Well outside a body's width, and already leaning out of the way.
    expect(give(north)).toBeGreaterThan(0);
    expect(give(south)).toBeGreaterThan(0);
    // Each to its own side: across the walk, not back along it.
    expect(Math.abs(north.nudgeWanted[0])).toBeGreaterThan(Math.abs(north.nudgeWanted[1]) * 3);
    expect(Math.sign(north.nudgeWanted[0])).toBe(-Math.sign(south.nudgeWanted[0]));
  });

  it('sees a pair crossing at right angles, which looks nothing like head-on', () => {
    /*
     * The overlap that was left once the head-on case was fixed, and the reason
     * the warning is read off the closing *rate* rather than off whether the two
     * of them are roughly nose to nose. Two figures crossing at a right angle
     * close at about seven tenths of head-on speed — fast enough to need most of
     * the same warning — and the worst overlap in a four-minute office was
     * exactly this: an agent and a caretaker, both walking, 0.31 apart.
     */
    const north = body('a', [0, 0, 0], { phase: 'walking', heading: 0 });
    const west = body('b', [0.636, 0, 0.636], { phase: 'walking', heading: -Math.PI / 2 });
    separateFigures(crowd([north, west]));
    expect(give(north)).toBeGreaterThan(0);
    expect(give(west)).toBeGreaterThan(0);
  });

  it('gives half the warning when only one of them is moving', () => {
    /*
     * Half the closing speed, half the look-ahead, because the look-ahead is a
     * braking distance and not a number of bodies: at this range a head-on pair
     * is already giving way and somebody walking at a figure standing still is
     * not, since it has twice as long to deal with it.
     */
    const walker = body('a', [0, 0, 0], { phase: 'walking', heading: 0 });
    const standing = body('b', [0, 0, 2.2]);
    separateFigures(crowd([walker, standing]));
    expect(give(walker)).toBe(0);

    const toward = body('c', [0, 0, 0], { phase: 'walking', heading: 0 });
    const against = body('d', [0, 0, 2.2], { phase: 'walking', heading: Math.PI });
    separateFigures(crowd([toward, against]));
    expect(give(toward)).toBeGreaterThan(0);
  });

  it('does not swerve around somebody it is merely following', () => {
    // The early warning is for a pair closing at twice walking pace. One figure
    // walking the same way as another, a body and a half back, is not that, and
    // swerving there would make the whole office weave.
    const ahead = body('a', [0, 0, 0.9], { phase: 'walking', heading: 0 });
    const behind = body('b', [0, 0, 0], { phase: 'walking', heading: 0 });
    separateFigures(crowd([ahead, behind]));
    expect(give(ahead)).toBe(0);
    expect(give(behind)).toBe(0);
  });

  it('never asks anybody to step further than the cap', () => {
    // The nudge does not know where the floor ends, so the cap is the only
    // thing keeping a crowded figure on its terrace.
    const people = Array.from({ length: 8 }, (_, i) => body(`f${i}`, [5 + i * 0.05, 0, 5 - i * 0.04]));
    separateFigures(crowd(people));
    for (const person of people) expect(give(person)).toBeLessThanOrEqual(GIVE + 1e-9);
  });
});

/**
 * Two figures actually walking at each other, frame by frame.
 *
 * Every test above checks one call of the pass, which is the right way to ask
 * what it decides and cannot ask the question that matters: the step aside is
 * *eased* in, so what ends up on screen is the pass's answer from a fraction of
 * a second ago, and whether that is good enough depends on how fast the two of
 * them were closing. Four minutes of the real office found the answer was "not
 * always" and could not say why — a sampled run of a live simulation is noisy
 * enough that one bad crossing and five are the same reading twice.
 *
 * So the crossing is reproduced here instead: two figures on intersecting
 * courses at walking pace, stepped at sixty frames a second with the real
 * easing, swept across every angle they can meet at. It runs in a millisecond
 * and it is the same answer every time.
 */
const WALK = 2.7;
/**
 * The slow ease, deliberately.
 *
 * The controller has a second, much faster rate for a correction a whole body
 * bigger than the one in hand — a figure rehomed onto a rebuilt campus, say —
 * and modelling it here would only make these numbers flatter than the thing
 * they are standing in for. Two figures walking into each other is the case
 * where the lean has to be gentle, so the gentle one is what is measured.
 */
const EASE = 7;

function crossing(degrees: number, scale = 1.8): number {
  const theta = (degrees * Math.PI) / 180;
  // A travels +x from three units out; B's course is turned `degrees` from
  // head-on, started so that both reach the origin at the same moment.
  const courses: [number, number][] = [
    [1, 0],
    [-Math.cos(theta), -Math.sin(theta)],
  ];
  const starts: [number, number][] = [
    [-3, 0],
    [3 * Math.cos(theta), 3 * Math.sin(theta)],
  ];
  const people = courses.map((course, i) =>
    body(i === 0 ? 'a' : 'b', [starts[i]![0], 0, starts[i]![1]], {
      phase: 'walking',
      scale,
      heading: Math.atan2(course[0], course[1]),
    }),
  );
  // The eased offset, which is what is drawn. `nudgeWanted` is what the pass
  // asked for; the figure is somewhere behind it.
  const drawn = people.map(() => [0, 0] as [number, number]);

  const dt = 1 / 60;
  let worst = Infinity;
  /*
   * The first few frames are not measured, and the reason is geometry rather
   * than convenience. At a shallow angle the two paths are nearly the same line,
   * so "three units out along each course" starts the pair a quarter of a unit
   * apart — already overlapping, before the pass has had a single frame to ease
   * anything. That case is a fair one and it is tested directly above, by hand,
   * as two figures standing in the same place. What is being asked here is what
   * happens when two figures *walk into* each other, so the clock starts once
   * the pass has had a third of a second to answer for where they began.
   */
  const settle = 20;
  for (let frame = 0; frame < 180; frame += 1) {
    people.forEach((person, i) => {
      person.position[0] += courses[i]![0] * WALK * dt;
      person.position[2] += courses[i]![1] * WALK * dt;
    });
    separateFigures(crowd(people));
    const ease = Math.min(1, dt * EASE);
    people.forEach((person, i) => {
      drawn[i]![0] += (person.nudgeWanted[0] - drawn[i]![0]) * ease;
      drawn[i]![1] += (person.nudgeWanted[1] - drawn[i]![1]) * ease;
    });

    const [a, b] = people as [Stub, Stub];
    const gap = Math.hypot(
      a.position[0] + drawn[0]![0] - (b.position[0] + drawn[1]![0]),
      a.position[2] + drawn[0]![1] - (b.position[2] + drawn[1]![1]),
    );
    if (frame >= settle) worst = Math.min(worst, gap / (a.bodyRadius + b.bodyRadius));
  }
  return worst;
}

describe('walking at each other', () => {
  it('never draws one figure inside another, at any angle they can meet at', () => {
    const angles = [0, 10, 20, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 175];
    const worst = new Map<number, number>();
    for (const angle of angles) worst.set(angle, crossing(angle));

    for (const [angle, ratio] of worst) {
      /*
       * Nine tenths of a body, which is to say they very nearly do not touch at
       * all. The worst angle two figures can meet at is about fifteen degrees
       * off following each other, and even there they pass at 0.96 — every other
       * angle clears completely. For scale, the pass this replaced drew its worst
       * pair at 0.07: one figure standing inside the other.
       */
      expect(ratio, `${angle}° apart, closest approach ${ratio.toFixed(2)} of a body`).toBeGreaterThan(0.9);
    }
  });

  it('threads a gap too narrow for it without ending up inside either of them', () => {
    /*
     * The case the live office kept failing on, and the one a pair of figures
     * cannot show you.
     *
     * Two people standing closer together than two bodies, and somebody walking
     * between them. Nothing can make that fit — the gap is the gap — but there
     * are two ways not to fit, and they look nothing alike: brushing past both
     * of them, or walking through the middle of one. It came out as the second,
     * at a tenth of a body, for a reason that has nothing to do with the
     * geometry: the two pushes were worked out one pair at a time, so the second
     * was measured from a position the first had already moved, and instead of
     * cancelling they took turns. See the snapshot in `separateFigures`.
     */
    const left = body('l', [-0.5, 0, 0]);
    const right = body('r', [0.5, 0, 0]);
    const thru = body('t', [0, 0, 3], { phase: 'walking', heading: Math.PI });
    const people = [left, right, thru];
    const drawn = people.map(() => [0, 0] as [number, number]);

    const dt = 1 / 60;
    let worst = Infinity;
    for (let frame = 0; frame < 120; frame += 1) {
      thru.position[2] -= WALK * dt;
      separateFigures(crowd(people));
      const ease = Math.min(1, dt * EASE);
      people.forEach((person, i) => {
        drawn[i]![0] += (person.nudgeWanted[0] - drawn[i]![0]) * ease;
        drawn[i]![1] += (person.nudgeWanted[1] - drawn[i]![1]) * ease;
      });
      if (frame < 10) continue;
      for (const other of [left, right]) {
        const o = people.indexOf(other);
        const gap = Math.hypot(
          thru.position[0] + drawn[2]![0] - (other.position[0] + drawn[o]![0]),
          thru.position[2] + drawn[2]![1] - (other.position[2] + drawn[o]![1]),
        );
        worst = Math.min(worst, gap / (thru.bodyRadius + other.bodyRadius));
      }
    }
    // Half a body from each, which is the middle of the gap and all there is.
    expect(worst, `closest approach threading the gap: ${worst.toFixed(2)}`).toBeGreaterThan(0.45);
  });

  it('spaces a row of three evenly rather than favouring one end', () => {
    // The same property, stated directly: the middle figure is pushed from both
    // sides, and both sides have to count the same amount.
    const row = [body('a', [0, 0, 0]), body('b', [0, 0, 0.8]), body('c', [0, 0, 1.6])];
    separateFigures(crowd(row));
    const at = (figure: Stub): number => figure.position[2] + figure.nudgeWanted[1];
    expect(at(row[1]!) - at(row[0]!)).toBeCloseTo(at(row[2]!) - at(row[1]!), 2);
  });

  it('holds at every size the models come in', () => {
    // A Fable is half again the width of a Haiku, and the two of them meeting is
    // the widest pair the office can produce.
    for (const scale of [1.38, 1.58, 1.8, 2.02]) {
      for (const angle of [0, 45, 90, 135]) {
        const ratio = crossing(angle, scale);
        expect(ratio, `scale ${scale} at ${angle}°: ${ratio.toFixed(2)}`).toBeGreaterThan(0.9);
      }
    }
  });
});
