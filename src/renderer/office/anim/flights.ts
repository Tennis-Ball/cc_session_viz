import type { Vec3 } from '../world/navGraph';

/**
 * Things that cross the office on their own.
 *
 * A message between two sessions is the one event with no figure to act it out:
 * both ends are standing still. So an envelope makes the trip, which is the
 * only way the office shows two sessions talking to each other.
 */

export interface Flight {
  id: number;
  from: Vec3;
  to: Vec3;
  startedAt: number;
  durationMs: number;
  color: string;
}

export interface FlightPose {
  position: Vec3;
  heading: number;
  /** 0–1, so an envelope fades in and out rather than popping. */
  presence: number;
  color: string;
}

const MIN_MS = 900;
const MAX_MS = 2200;
/** Envelopes are a garnish; more than this on screen is confetti. */
const MAX_FLIGHTS = 24;

export class FlightPool {
  private flights: Flight[] = [];
  private nextId = 1;

  /** Pace by distance, so a long trip does not look like a bullet. */
  send(from: Vec3, to: Vec3, color: string, now: number): void {
    const distance = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    const durationMs = Math.min(MAX_MS, Math.max(MIN_MS, distance * 90));
    this.flights.push({ id: this.nextId++, from, to, startedAt: now, durationMs, color });
    if (this.flights.length > MAX_FLIGHTS) this.flights.splice(0, this.flights.length - MAX_FLIGHTS);
  }

  get count(): number {
    return this.flights.length;
  }

  clear(): void {
    this.flights.length = 0;
  }

  /** Current pose of every envelope in the air; finished ones are retired. */
  poses(now: number): FlightPose[] {
    const out: FlightPose[] = [];
    let write = 0;

    for (const flight of this.flights) {
      const t = (now - flight.startedAt) / flight.durationMs;
      if (t >= 1) continue;
      this.flights[write++] = flight;
      if (t < 0) continue;

      const eased = easeInOutSine(t);
      const x = flight.from[0] + (flight.to[0] - flight.from[0]) * eased;
      const z = flight.from[2] + (flight.to[2] - flight.from[2]) * eased;
      const straight = flight.from[1] + (flight.to[1] - flight.from[1]) * eased;
      // A shallow parabola: high enough to read as flight, low enough to stay
      // inside the frame at every camera angle.
      const span = Math.hypot(flight.to[0] - flight.from[0], flight.to[2] - flight.from[2]);
      const lift = Math.min(3.4, 0.22 * span + 0.9) * 4 * eased * (1 - eased);

      out.push({
        position: [x, straight + lift + 1.1, z],
        heading: Math.atan2(flight.to[0] - flight.from[0], flight.to[2] - flight.from[2]),
        presence: Math.min(1, Math.min(t, 1 - t) * 6),
        color: flight.color,
      });
    }

    this.flights.length = write;
    return out;
  }
}

function easeInOutSine(t: number): number {
  return 0.5 - Math.cos(Math.PI * t) / 2;
}
