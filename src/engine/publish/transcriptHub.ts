import { TRANSCRIPT_FLUSH_MS, type EngineMsg } from '../../shared/protocol';
import type { EntryLog } from '../state/entryLog';
import type { Publisher } from './publisher';

export interface LogSource {
  logFor(cardId: string): EntryLog | undefined;
}

/**
 * Streams transcript entries only for the cards currently on screen.
 *
 * Canvas mode subscribes to what is visible at a readable zoom and drops the
 * rest, so a board with thirty sessions doesn't ship thirty live transcripts.
 */
export class TranscriptHub {
  private subscribed = new Set<string>();
  private primed = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly publisher: Publisher,
    private readonly source: () => LogSource,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.flush(), TRANSCRIPT_FLUSH_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setSubscriptions(ids: string[]): void {
    this.subscribed = new Set(ids);
    for (const id of [...this.primed]) {
      if (!this.subscribed.has(id)) this.primed.delete(id);
    }
    this.flush();
  }

  private flush(): void {
    for (const id of this.subscribed) {
      const log = this.source().logFor(id);
      if (!log) continue;

      if (!this.primed.has(id)) {
        // First send is the whole tail the engine is holding for this card.
        this.primed.add(id);
        log.drain();
        this.send({ type: 'transcript', id, reset: true, append: log.all(), hasMore: log.hasMore });
        continue;
      }

      const { append, update } = log.drain();
      if (append.length === 0 && update.length === 0) continue;
      this.send({ type: 'transcript', id, append, update, hasMore: log.hasMore });
    }
  }

  private send(msg: EngineMsg): void {
    this.publisher.broadcast(msg);
  }
}
