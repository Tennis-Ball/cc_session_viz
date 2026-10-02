import type { Horizon } from '@shared/prefs';
import { rng } from '@shared/rand';

/**
 * What is out there, past the campus.
 *
 * The distance used to be painted: two silhouettes evaluated in the atmosphere
 * shader, in screen space, over the sky. That is cheap and it is a lie, and the
 * lie shows the moment you touch the camera — the office swings and the
 * mountains do not, because a screen-space ridge has no idea the world turned.
 * What you get is a printed backdrop behind a model, and no amount of tuning
 * the silhouette fixes the one thing wrong with it.
 *
 * So the distance is built out of the same parts as everything else: stepped
 * decks on tapering rock, floating in the same void. It costs one draw call, it
 * turns when you turn, it takes the theme and the hour through the same facet
 * shader, and it is unmistakably the same place seen further off — which is the
 * whole reason to have a horizon at all.
 *
 * Pure and seeded, so a world's distance is as reproducible as its campus.
 */

export interface SceneryPiece {
  /** Full extents. */
  size: [number, number, number];
  /** Centred in x and z; `at[1]` is the base. */
  at: [number, number, number];
  /**
   * How much sky is already mixed into the stone, 0…1.
   *
   * The office is drawn through an orthographic camera, which is the whole
   * problem with distance here: two identical slabs at two different distances
   * are exactly the same size on screen, and there is no perspective to tell
   * them apart. Aerial perspective is the only cue left, and the depth fog
   * alone cannot carry it — the fog is measured along the view axis, so a
   * landmark to the *side* of the campus reads as near however far out it
   * stands. Baking the wash in by radius is the honest version: it is a
   * property of where the thing is, not of where you happen to be looking from.
   */
  wash: number;
  /** Rock sits under the deck and reads a shade deeper, as it does at home. */
  rock: boolean;
  /** Turned off the office's two axes, so a landmark is not another terrace. */
  yaw: number;
  grad: [number, number];
}

/*
 * How far out, as a multiple of the campus's own radius.
 *
 * Not in units, and this is the whole of what makes the idea work. The camera
 * is orthographic and re-fits itself around the platforms, so the window shows
 * a *fixed box* of world — a little over a hundred units across — however big
 * the campus inside it is. The first version of this put isles at a radius of
 * sixty-five to two hundred and fifteen units, which is a beautiful ring that
 * is entirely outside the frame: built, merged, drawn, never once seen.
 *
 * So distance here is not metres. It is the two cues an orthographic camera
 * still has — things over there are *small*, and they are *washed toward the
 * sky* — applied to something standing just past the edge of the campus, where
 * the frame can actually reach it.
 *
 * Where the frame can reach is worth writing down, because it is not obvious,
 * it is narrow, and it decides every number in this file.
 *
 * Screen height is `sin(polar) * y - cos(polar) * (distance along the view)`.
 * The camera fits the campus to 95% of the window *width*, which leaves about
 * two units of sky over the roofs and a good deal of empty void underneath. So:
 * a landmark on the *far* arc is pushed up the frame by its distance, straight
 * off the top or straight behind the office; one on the *near* arc is pushed
 * down, into the void below the keels, where there is room; and one at the
 * sides keeps its own height and lands in a corner.
 *
 * Two rules come out of that, and both are the opposite of what a horizon
 * wants. Everything here is *small*, because nothing shrinks with distance
 * under this camera and scale is the only cue left. And everything here is
 * *low* — nothing rises past the office's own floor by more than a few units,
 * because anything that does comes round the near arc and draws a column
 * through the middle of the building.
 *
 * What that leaves is not a skyline. It is an archipelago: fragments of the
 * same stone drifting in the void the campus floats in, below it and beside it,
 * which is what the void wanted all along.
 */
/**
 * How far *under* the office's lowest floor everything out here has to stay.
 *
 * A landmark level with the terraces reads as another building: it is the same
 * size range, the same stone and the same silhouette, so the eye files it with
 * the office and then wonders what that block is doing hanging in the sky
 * beside it. Everything here sits in the band of void the campus floats over,
 * where nothing else is, and the only thing it can be read as is more of the
 * same world further down and further off.
 */
const CEILING = -3;

/**
 * The radius of the ring, as a multiple of the campus's half-footprint.
 *
 * A *ring*, all the way round, which is the fourth arrangement tried here and
 * the first that does not have to choose a corner of the frame to live in. The
 * reason to go back to a ring is the rotation: a band aimed at one part of the
 * window has to be pinned to the camera to stay there, and something pinned to
 * the camera does not move when you orbit, which reads as a sticker on the
 * glass rather than as distance. A ring can afford to turn slowly, because
 * whichever way you face there is more of it coming round.
 *
 * Under this projection a ring draws as an ellipse: as wide as its radius and
 * about three-quarters as tall. The bounds are what keep that ellipse in the
 * window — inside this and it cuts through the office, outside it and the sides
 * are past the frame edge. The arc astern rides high in the sky, the two sides
 * sit in the margins, and the near arc goes down into the fog under the keels,
 * where the void fade has it before the eye does.
 */
const NEAR = 1.3;
const FAR = 1.52;

/**
 * How far the whole ring is swung, per world.
 *
 * Without it every world puts its first isle at the same bearing and the
 * archipelago is the same shape in all of them — which was reported, in those
 * words: the isles do not change when the world does.
 */
const SWING = Math.PI * 2;

/**
 * @param centre The middle of the campus in plan, which is *not* the origin.
 * @param spread Half the campus's own footprint — everything stands past it.
 */
export function buildScenery(kind: Horizon, seed: number, floorY: number, spread: number): SceneryPiece[] {
  if (kind === 'none') return [];
  // Its own stream, so adding a landmark never reshuffles the campus.
  const random = rng(seed * 7919 + 13);
  const pieces: SceneryPiece[] = [];
  const count = 16;
  const reach = Math.max(18, spread);
  // Swung once for the whole ring, so it keeps its shape and the world still
  // turns out somewhere new.
  const swing = random() * SWING;

  /*
   * Which slot each landmark takes, drawn rather than walked in order.
   *
   * There are more slots than landmarks, so drawing without replacement gives a
   * different *shape* of archipelago each time — clustered at one end in one
   * world, strung out in another — rather than the same seven positions with
   * jitter on them.
   */
  /*
   * Evenly round, then jittered, rather than drawn from a bag.
   *
   * A bag of slots clusters, and a cluster of landmarks is one lump of pale
   * rectangles rather than a horizon. Even spacing is what makes a ring read as
   * a ring; the jitter and the per-isle depth are what keep it from reading as
   * a clock face.
   */
  for (let i = 0; i < count; i += 1) {
    const angle = swing + ((i + (random() - 0.5) * 0.55) / count) * Math.PI * 2;
    const depth = Math.pow(random(), 0.8);
    const radius = reach * (NEAR + depth * (FAR - NEAR));
    /*
     * How far off this one reads, which is scale and wash and nothing else.
     *
     * Under an orthographic camera distance has no effect on size, so the only
     * way to say "that is a long way off" is to paint it on. The ring's radius
     * cannot help: it is pinned to a narrow range so the ellipse stays in the
     * window, and in any case every point of a ring is the same distance away.
     */
    const wash = depth;
    const scale = 0.62 - wash * 0.2;
    // Astern is -z and across is +x in this module's own frame; `Distance`
    // turns the whole ring to face the camera, slowly. A bearing of zero is
    // dead astern, which is the top of the ellipse and the top of the window.
    pieces.push(
      ...isle(Math.sin(angle) * radius, -Math.cos(angle) * radius, floorY, wash, scale, random),
    );
  }

  return pieces;
}

/**
 * A small terrace on its own rock: the campus's own silhouette, further off.
 *
 * Deliberately smaller than anything the office stands on. Under an
 * orthographic camera nothing shrinks with distance, so scale is the one
 * remaining way to say "that is over there": a deck half the size of the one
 * you are standing on reads as further away before the wash has said a word.
 */
function isle(
  x: number,
  z: number,
  floorY: number,
  wash: number,
  scale: number,
  random: () => number,
): SceneryPiece[] {
  const pieces: SceneryPiece[] = [];
  /*
   * Smaller than anything the office stands on, and that is the point.
   *
   * These were made as wide as a platform on the reasoning that an orthographic
   * camera shrinks nothing, so size cannot say "far away" — true, and it misses
   * what size *can* say, which is "this is not one of those". A landmark the
   * same size as a terrace, in the same stone, with the same silhouette, is
   * filed by the eye as another terrace that has come adrift; at a third of
   * that it is scenery, and the campus stays the only building in the picture.
   */
  const width = (5.5 + random() * 5) * scale;
  const depth = (5.5 + random() * 5) * scale;
  /*
   * Just under the office's own floor, or a little over it, and never more.
   *
   * Bounded from both ends. Above, by the note on the band at the top of this
   * file: anything that clears the roofline draws a column through the middle
   * of the building when the camera comes round to it. Below, by the facet
   * shader, which dissolves everything under the void plane into the sky — that
   * is what makes the office float, and an isle scattered forty units down
   * comes out as pure sky. What the fade is good for is the *keel*, which
   * should trail off into nothing; the deck has to stay where there is colour.
   */
  const top = floorY + CEILING - Math.pow(random(), 0.9) * 3.6;
  /** What a crown may use without breaking the ceiling above. */
  const headroom = floorY + CEILING - top;
  const deck = (0.85 + random() * 0.35) * scale;

  /*
   * Turned off the grid, which is most of what makes them read as land.
   *
   * Every box in the office is square to the same two axes, and so was every
   * landmark — so the distance came out as a scatter of pale rectangles with
   * their corners pointing the same way as the building's, which the eye reads
   * as more building. A few degrees of yaw is enough: the silhouette stops
   * agreeing with the architecture and starts being scenery, and it costs one
   * number per isle.
   */
  const yaw = (random() - 0.5) * 0.9;

  pieces.push({ size: [width, deck, depth], at: [x, top - deck, z], wash, rock: false, yaw, grad: [0.62, 1] });
  // A second slab across the first, so the outline has a corner that is not a
  // corner of a rectangle.
  pieces.push({
    size: [width * (0.5 + random() * 0.3), deck * 0.92, depth * (0.9 + random() * 0.5)],
    at: [x + (random() - 0.5) * width * 0.5, top - deck * 0.98, z + (random() - 0.5) * depth * 0.5],
    wash,
    rock: false,
    yaw: yaw + (random() - 0.5) * 0.7,
    grad: [0.62, 1],
  });

  // The keel: courses stepping in and getting shorter, which is how the rock
  // under a platform is cut at home.
  let w = width * 0.86;
  let d = depth * 0.86;
  let y = top - deck;
  const courses = 2 + Math.floor(random() * 2);
  for (let i = 0; i < courses; i += 1) {
    const tall = (1.1 + random() * 2.4) * scale;
    y -= tall;
    pieces.push({ size: [w, tall, d], at: [x, y, z], wash, rock: true, yaw, grad: [0.3, 0.92] });
    w *= 0.76 + random() * 0.1;
    d *= 0.76 + random() * 0.1;
  }

  /*
   * Something standing on about half of them.
   *
   * An archipelago of bare slabs is a diagram; one with a tower on the third
   * island is a country. Both crowns are cut to whatever headroom the isle has
   * left, and an isle riding high enough to have none simply goes without —
   * which is the only way the ceiling holds for every seed rather than for the
   * ones that happened to be tested.
   */
  const roll = random();
  if (roll < 0.14 && headroom > 1.4) {
    let side = Math.min(width, depth) * (0.2 + random() * 0.12);
    let t = top;
    const stages = 2 + Math.floor(random() * 3);
    for (let i = 0; i < stages; i += 1) {
      const tall = Math.min((1.4 + random() * 2.2) * scale, floorY + CEILING - t - 0.24);
      if (tall < 0.3) break;
      pieces.push({ size: [side, tall, side], at: [x, t, z], wash, rock: false, yaw, grad: [0.5, 1] });
      t += tall;
      pieces.push({ size: [side * 1.35, 0.22 * scale, side * 1.35], at: [x, t, z], wash, rock: true, yaw, grad: [0.7, 1] });
      t += 0.22 * scale;
      side *= 0.78;
    }
  } else if (roll < 0.3 && headroom > 1.6) {
    // Two posts and a lintel: the arch, at the size it survives being far away.
    const post = (0.34 + random() * 0.2) * scale;
    const span = Math.min(width, depth) * 0.62;
    const height = Math.min((1.8 + random() * 2.6) * scale, headroom - 0.5);
    for (const side of [-1, 1]) {
      pieces.push({ size: [post, height, post], at: [x + side * (span / 2), top, z], wash, rock: false, yaw, grad: [0.44, 1] });
    }
    pieces.push({
      size: [span + post * 2.4, 0.42 * scale, post * 1.6],
      at: [x, top + height, z],
      wash,
      rock: false,
      yaw,
      grad: [0.68, 1],
    });
  }

  return pieces;
}
