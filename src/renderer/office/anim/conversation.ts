import { rng } from '@shared/rand';
import type { FigureController } from './figureController';

/**
 * Two people who have stopped to talk.
 *
 * The office was full of people going places and doing things, and every one
 * of them was doing it alone. That is the difference between a workplace and a
 * diagram of one: nothing in it had ever *noticed* anything else. Birds notice
 * people, which is why they were worth having; this is the same trick applied
 * to the people.
 *
 * There are no speech bubbles and there is no dialogue, for the same reason
 * there is none anywhere else here — the office says things by where somebody
 * is and how they move. A conversation is three cues and nothing more: they
 * stop, they turn to face each other, and they take it in turns to nod. That
 * is legible at every zoom the labels survive, and at the zooms they do not it
 * reads as two figures standing together, which is still true.
 *
 * It is deliberately built out of parts that already exist. `faceTowards` is a
 * turn on the spot; `nod` is the beat a figure already plays when it
 * acknowledges something. Nothing here animates anybody; it decides who is
 * listening to whom, and the figures do the rest.
 */

/** How close two people have to be before either notices the other. */
export const REACH = 2.6;
/**
 * And how far apart they may drift before it is over.
 *
 * Wider than `REACH` on purpose. Equal, and a pair hovering at exactly the
 * threshold starts and stops a conversation every few frames, which reads as
 * two people twitching at each other.
 */
export const PART = 3.4;

/**
 * A turn of speaking, and how long the whole thing lasts.
 *
 * The turns used to run to three seconds, which is about right for two people
 * and quite wrong for two figures thirty pixels tall: for most of every turn
 * nothing at all was moving, and a conversation you only catch one second in
 * three of is a conversation nobody notices. Short enough that somebody is
 * always mid-gesture.
 */
const TURN_MIN_MS = 900;
const TURN_MAX_MS = 1900;
const CHAT_MIN_MS = 9000;
const CHAT_MAX_MS = 26000;

/**
 * And for a chat the world actually reported.
 *
 * An exchange of messages is a specific thing that happened at a specific
 * moment, not two people with time on their hands, so it is short and it is
 * not subject to the cooldown — if they send three messages they talk three
 * times.
 */
const ERRAND_MIN_MS = 5000;
const ERRAND_MAX_MS = 9000;

/**
 * How long after one ends before either of them will start another.
 *
 * Without it the same two people, still standing next to each other, begin
 * again the instant they finish, and what you have is not a conversation but a
 * pair of figures nodding at each other for the rest of the afternoon.
 */
const COOLDOWN_MS = 24000;

/** Per person per second, once they are near somebody worth talking to. */
const STRIKE_UP_PER_SECOND = 0.22;

interface Chat {
  a: string;
  b: string;
  /** Whose turn it is to be talking. */
  speaker: string;
  nextTurn: number;
  until: number;
  /**
   * Whether the world said these two were talking, or the office decided it.
   *
   * It changes what the card may claim. "Talking to Explore" is a statement
   * about your machine and has to be true; two caretakers passing the time are
   * scenery, and the card says so.
   */
  real: boolean;
}

/** What the office offers up as somebody who could be talked to. */
export interface Talker {
  controller: FigureController;
  /**
   * Whether this one is free to stop and chat.
   *
   * Caretakers always are. An agent is only free when it is idle: somebody in
   * the middle of a turn has work to do, and a session that is being waited on
   * standing about chatting is the office telling you something untrue.
   */
  idle: boolean;
}

export class Conversations {
  private readonly chats: Chat[] = [];
  private readonly busy = new Map<string, Chat>();
  private readonly quietUntil = new Map<string, number>();
  private readonly random: () => number;

  constructor(seed: number) {
    this.random = rng(seed ^ 0x7a1c);
  }

  /** True while this one is in a conversation, so nobody sends them away. */
  talking(id: string): boolean {
    return this.busy.has(id);
  }

  /** And who with, for the card. */
  partner(id: string): string | null {
    const chat = this.busy.get(id);
    if (!chat) return null;
    return chat.a === id ? chat.b : chat.a;
  }

  /** True when this one is in a conversation the world reported, not scenery. */
  reported(id: string): boolean {
    return this.busy.get(id)?.real === true;
  }

  /**
   * These two have just sent each other something; have them talk about it.
   *
   * Called from the message event rather than discovered here, because the
   * office cannot tell by looking: two figures standing together have no idea
   * whether anything passed between them. Extends a conversation already
   * running rather than starting a second one, so a burst of messages reads as
   * one exchange getting longer.
   */
  summon(a: string, b: string, now: number): void {
    const running = this.busy.get(a);
    if (running && (running.a === b || running.b === b)) {
      running.real = true;
      running.until = Math.max(running.until, now + ERRAND_MIN_MS);
      return;
    }
    // Either of them may be mid-conversation with somebody else; the one that
    // actually happened wins, and the other is simply over.
    this.end(a, now);
    this.end(b, now);
    const chat: Chat = {
      a,
      b,
      speaker: a,
      nextTurn: now,
      until: now + ERRAND_MIN_MS + this.random() * (ERRAND_MAX_MS - ERRAND_MIN_MS),
      real: true,
    };
    this.chats.push(chat);
    this.busy.set(a, chat);
    this.busy.set(b, chat);
  }

  private end(id: string, now: number): void {
    const chat = this.busy.get(id);
    if (!chat) return;
    const index = this.chats.indexOf(chat);
    if (index >= 0) this.chats.splice(index, 1);
    this.busy.delete(chat.a);
    this.busy.delete(chat.b);
    this.quietUntil.set(chat.a, now + COOLDOWN_MS);
    this.quietUntil.set(chat.b, now + COOLDOWN_MS);
  }

  update(talkers: readonly Talker[], dt: number, now: number): void {
    const byId = new Map(talkers.map((talker) => [talker.controller.id, talker]));

    // Run what is already happening, and drop whatever has finished.
    for (let i = this.chats.length - 1; i >= 0; i -= 1) {
      const chat = this.chats[i]!;
      const a = byId.get(chat.a);
      const b = byId.get(chat.b);
      const apart =
        !a ||
        !b ||
        gap(a.controller, b.controller) > PART ||
        a.controller.phase !== 'standing' ||
        b.controller.phase !== 'standing';

      if (apart || now >= chat.until) {
        this.chats.splice(i, 1);
        this.busy.delete(chat.a);
        this.busy.delete(chat.b);
        // Both of them, whether they are still here or not: the one who walked
        // off should not turn round and start again either.
        this.quietUntil.set(chat.a, now + COOLDOWN_MS);
        this.quietUntil.set(chat.b, now + COOLDOWN_MS);
        continue;
      }

      // Facing is re-asserted every tick rather than set once: either of them
      // may be nudged aside by somebody squeezing past, and a pair talking to
      // the spot where the other one used to be is worse than no conversation.
      a.controller.faceTowards(b.controller.position);
      b.controller.faceTowards(a.controller.position);

      if (now >= chat.nextTurn) {
        // One holds forth and the other acknowledges, then they swap. Both
        // move on every turn: a listener standing perfectly still for two
        // seconds reads as a figure that has stopped working, not as somebody
        // being talked to.
        const speaking = chat.speaker === chat.a ? a : b;
        const listening = chat.speaker === chat.a ? b : a;
        speaking.controller.play('speak', now);
        listening.controller.play('nod', now);
        chat.speaker = chat.speaker === chat.a ? chat.b : chat.a;
        chat.nextTurn = now + TURN_MIN_MS + this.random() * (TURN_MAX_MS - TURN_MIN_MS);
      }
    }

    // Then look for anybody who might start one. Rate is per second, so the
    // chance does not depend on how often this happens to be called.
    const chance = 1 - Math.pow(1 - STRIKE_UP_PER_SECOND, Math.max(0, dt));
    for (let i = 0; i < talkers.length; i += 1) {
      const a = talkers[i]!;
      if (!this.free(a, now)) continue;
      for (let j = i + 1; j < talkers.length; j += 1) {
        const b = talkers[j]!;
        if (!this.free(b, now)) continue;
        if (gap(a.controller, b.controller) > REACH) continue;
        if (this.random() > chance) continue;

        const chat: Chat = {
          a: a.controller.id,
          b: b.controller.id,
          speaker: a.controller.id,
          nextTurn: now,
          until: now + CHAT_MIN_MS + this.random() * (CHAT_MAX_MS - CHAT_MIN_MS),
          real: false,
        };
        this.chats.push(chat);
        this.busy.set(chat.a, chat);
        this.busy.set(chat.b, chat);
        break;
      }
    }
  }

  /** Everybody goes home: the campus changed, or the crowd was turned off. */
  clear(): void {
    this.chats.length = 0;
    this.busy.clear();
    this.quietUntil.clear();
  }

  private free(talker: Talker, now: number): boolean {
    return (
      talker.idle &&
      talker.controller.phase === 'standing' &&
      !this.busy.has(talker.controller.id) &&
      now >= (this.quietUntil.get(talker.controller.id) ?? 0)
    );
  }
}

/**
 * How far apart two of them are, on the floor.
 *
 * Height is not in it on purpose: two people either side of a terrace edge,
 * one level apart, are not within talking distance of each other however close
 * they look from above — and they *do* look close from above, because this is
 * an isometric camera. The height check is what keeps somebody from holding a
 * conversation with the top of somebody else's head.
 */
export function gap(a: FigureController, b: FigureController): number {
  if (Math.abs(a.position[1] - b.position[1]) > 1.1) return Infinity;
  return Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]);
}
