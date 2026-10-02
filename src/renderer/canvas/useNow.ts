import { useEffect, useState } from 'react';

/**
 * A once-a-second clock, subscribed to by the components that show elapsed
 * time rather than threaded through the node data.
 *
 * It used to be a `now` field on every node's `data`, which meant the board
 * rebuilt every node and every edge object once a second purely so that a
 * handful of "1m 21s" strings could tick — and because the card id array was
 * rebuilt with them, the engine was re-sent the whole transcript subscription
 * every second too. The clock belongs to the components that read it.
 *
 * One interval for the whole board, shared by every subscriber: thirty cards
 * do not need thirty timers, and they all want the same second.
 */
const listeners = new Set<(now: number) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function start(): void {
  if (timer) return;
  timer = setInterval(() => {
    const now = Date.now();
    for (const listener of listeners) listener(now);
  }, 1000);
}

function stop(): void {
  if (timer && listeners.size === 0) {
    clearInterval(timer);
    timer = null;
  }
}

export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    listeners.add(setNow);
    start();
    return () => {
      listeners.delete(setNow);
      stop();
    };
  }, []);
  return now;
}
