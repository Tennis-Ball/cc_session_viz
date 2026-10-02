import type { Campus, Connector, Platform } from '../world/layout';

/**
 * Rooms arriving and leaving.
 *
 * A platform used to appear the instant the engine reported a session and
 * vanish the instant it ended — the whole campus is one merged mesh, so a new
 * desk was a mesh swap, which on screen is a building materialising out of
 * nothing between two frames. Switching between real sessions and the
 * simulation was the same thing eight times over: the office blinked, and a
 * different office was there.
 *
 * What it should do is what this world does everywhere else: rise out of the
 * fog it floats in. That needs three things the renderer did not have — a
 * memory of what was here a moment ago, somewhere to keep the ones on their way
 * out, and an order to do them in. All three are here; the shader does the
 * moving (see `staged` in `facet.ts`).
 *
 * Deliberately not a React hook and deliberately not in a store: this ticks at
 * frame rate and re-rendering the office sixty times a second to animate a
 * building is the one thing the office is carefully built not to do.
 */

/** Seconds a room takes to come up, and to go back down. */
const RISING = 1.6;
const SINKING = 1.15;
/**
 * And how far apart two of them start.
 *
 * Eight desks arriving together is the ordinary case — it is what switching
 * data sources does — and eight buildings rising in perfect unison reads as one
 * object with eight parts. Offset, it reads as a place filling up.
 */
const STAGGER = 0.14;
/** However many arrive at once, the last one starts by then. */
const STAGGER_CAP = 1.3;

/** A room on its way out, kept so it has something to sink. */
interface Leaving {
  platform: Platform;
  connectors: Connector[];
}

interface Slot {
  /** 0 struck, 1 settled. */
  t: number;
  target: 0 | 1;
  /** Seconds still to wait before moving. */
  delay: number;
}

export class Staging {
  private readonly slots = new Map<string, Slot>();
  private readonly leaving = new Map<string, Leaving>();
  /** Stable slot index per platform, so the uniform array is not reshuffled. */
  private readonly index = new Map<string, number>();
  private next = 1;
  /** Whether a campus has been seen at all yet. */
  private started = false;
  /** How far under the world a struck room sits; see `uStageDrop`. */
  private drop = 24;

  /**
   * Take a reading of the campus.
   *
   * Returns true when the *set* of things to draw changed, which is the only
   * occasion the merged geometry has to be rebuilt. Movement alone never
   * rebuilds anything: that is what the uniforms are for.
   */
  sync(campus: Campus, capacity: number): boolean {
    const present = new Set(campus.platforms.map((platform) => platform.id));
    let changed = false;

    /*
     * The first campus of a run arrives too.
     *
     * It was going to be exempt — watching your own office build itself is a
     * trick that wears out — but the alternative is the scene cutting in fully
     * formed on the first painted frame, which is the harshest transition the
     * app has and the one every launch starts with. Rising through it covers
     * exactly the moment there is nothing to look at yet, and it is over in
     * under three seconds.
     */
    if (!this.started) {
      this.started = true;
    }

    let arriving = 0;
    for (const platform of campus.platforms) {
      const known = this.slots.get(platform.id);
      if (this.leaving.delete(platform.id)) changed = true;
      if (!known) {
        // Struck, and on its way up.
        this.slotFor(platform.id, capacity);
        this.slots.set(platform.id, { t: 0, target: 1, delay: Math.min(STAGGER_CAP, arriving * STAGGER) });
        arriving += 1;
        changed = true;
      } else if (known.target === 0) {
        // It came back before it had finished going. Carry on from where it is.
        known.target = 1;
        known.delay = 0;
      }
    }

    let going = 0;
    for (const [id, slot] of this.slots) {
      if (present.has(id) || slot.target === 0) continue;
      slot.target = 0;
      slot.delay = Math.min(STAGGER_CAP, going * STAGGER);
      going += 1;
    }
    return changed;
  }

  /**
   * Remember a room that has gone, so it has something left to sink.
   *
   * Called with the campus from *before* the removal, because by the time a
   * platform is missing there is nothing left to take a copy of.
   */
  remember(campus: Campus): void {
    for (const platform of campus.platforms) {
      this.leaving.set(platform.id, {
        platform,
        connectors: campus.connectors.filter((c) => c.from === platform.id || c.to === platform.id),
      });
    }
  }

  /**
   * Advances every slot.
   *
   * `retired` is the half that matters to the renderer: it is the one frame on
   * which a room has finished sinking and has to come out of the merged mesh,
   * and it is the only thing in the whole animation that costs a React render.
   */
  step(dt: number): { moving: boolean; retired: boolean } {
    let moving = false;
    let retired = false;
    for (const [id, slot] of this.slots) {
      if (slot.delay > 0) {
        slot.delay = Math.max(0, slot.delay - dt);
        moving = true;
        continue;
      }
      const span = slot.target === 1 ? RISING : SINKING;
      const step = dt / span;
      if (slot.target === 1 && slot.t < 1) {
        slot.t = Math.min(1, slot.t + step);
        moving = true;
      } else if (slot.target === 0 && slot.t > 0) {
        slot.t = Math.max(0, slot.t - step);
        moving = true;
        // Fully struck and not wanted: forget it, and give the slot back.
        if (slot.t === 0) {
          this.retire(id);
          retired = true;
        }
      }
    }
    return { moving, retired };
  }

  /** Writes the eased values into the shader's array. */
  write(into: Float32Array): void {
    into.fill(1);
    for (const [id, slot] of this.slots) {
      const at = this.index.get(id);
      if (at === undefined) continue;
      into[at] = eased(slot.t);
    }
  }

  /** Which uniform slot a platform's vertices carry. 0 is "always here". */
  slotOf(id: string): number {
    return this.index.get(id) ?? 0;
  }

  /**
   * How far built a room is, 0–1, for everything that is *not* in the merged
   * mesh: its mast, its nameplate, the pool of light under its lamp.
   *
   * They are drawn by other components and the shader knows nothing about
   * them, so without this a new desk arrived as a flag and a name hanging in
   * mid-air over a platform still on its way up — which is a worse pop than
   * the one the whole exercise was meant to remove.
   */
  valueOf(id: string): number {
    const slot = this.slots.get(id);
    if (!slot) return 1;
    return eased(slot.t);
  }

  /** And in world units, for anything that would rather move than fade. */
  offsetOf(id: string): number {
    const under = (1 - this.valueOf(id)) * this.drop;
    // Not `-0`, which is a real value that reads as zero and compares as zero
    // and then shows up in a matrix and in a test result looking like a bug.
    return under === 0 ? 0 : -under;
  }

  /** Set once per campus by whoever owns the geometry. See `uStageDrop`. */
  setDrop(units: number): void {
    this.drop = units;
  }

  /** The platforms that are gone but still sinking, for the geometry build. */
  sinking(): Platform[] {
    const out: Platform[] = [];
    for (const [id, held] of this.leaving) {
      if (this.slots.has(id)) out.push(held.platform);
    }
    return out;
  }

  /**
   * And their walkways, so a room does not leave its stairs hanging.
   *
   * Every connector that touched a room on its way out, including the ones
   * whose other end is staying: the layout drops those the moment the platform
   * is gone, so without this a bridge to a closing desk vanished in one frame
   * while the desk it served spent a second sinking. It goes down *with* the
   * room instead, which is what a walkway being withdrawn looks like.
   */
  sinkingConnectors(): Connector[] {
    const out: Connector[] = [];
    const seen = new Set<string>();
    for (const [id, held] of this.leaving) {
      if (!this.slots.has(id)) continue;
      for (const connector of held.connectors) {
        const key = `${connector.from}>${connector.to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(connector);
      }
    }
    return out;
  }

  /**
   * Which end of a walkway decides how far built it is: the one that is
   * moving.
   *
   * Both ends always have a slot — every room the office has ever seen keeps
   * one — so "whichever is non-zero" picked the *first* end regardless, and a
   * bridge to an arriving desk was drawn complete, reaching out over nothing,
   * while the desk was still on its way up. The one that is not yet home is
   * the one the walkway has to travel with.
   */
  walkwaySlot(from: string, to: string): number {
    return this.valueOf(from) <= this.valueOf(to) ? this.slotOf(from) : this.slotOf(to);
  }

  /** True while any room is still moving, which is what drives the ticker. */
  busy(): boolean {
    for (const slot of this.slots.values()) {
      if (slot.delay > 0) return true;
      if (slot.target === 1 ? slot.t < 1 : slot.t > 0) return true;
    }
    return false;
  }

  private retire(id: string): void {
    this.slots.delete(id);
    this.index.delete(id);
    this.leaving.delete(id);
  }

  private slotFor(id: string, capacity: number): number {
    const existing = this.index.get(id);
    if (existing !== undefined) return existing;
    // Reuse a slot nobody holds before growing past the array.
    const taken = new Set(this.index.values());
    for (let i = 1; i < capacity; i += 1) {
      if (!taken.has(i)) {
        this.index.set(id, i);
        this.next = Math.max(this.next, i + 1);
        return i;
      }
    }
    // Out of room: everything past the end is simply always present, which is
    // the old behaviour rather than a broken one.
    this.index.set(id, 0);
    return 0;
  }
}

/**
 * Ease-out, so almost all of the travel happens while the room is still down
 * in the fog and the part you watch is the last slow settle.
 *
 * Read straight off `t` and never off the delay. Treating "waiting its turn" as
 * "struck" is right for a room on its way up and exactly wrong for one on its
 * way down: the second and third desks to leave blinked out of existence and
 * *then* sank, which is the pop this whole file exists to remove.
 */
function eased(t: number): number {
  return 1 - (1 - t) ** 3;
}
