import type { VisualEvent } from '@shared/events';
import type { EngineMsg, UiMsg } from '@shared/protocol';
import { useTranscripts } from '../store/transcripts';
import { useWorld } from '../store/world';

type EventListener = (event: VisualEvent) => void;

/**
 * Bridges the engine port into the store. Visual events are deliberately kept
 * *out* of React state: choreography subscribes here directly, so a burst of
 * events never causes a re-render storm.
 */
class EngineClient {
  private readonly eventListeners = new Set<EventListener>();
  private started = false;
  private subscription = '';

  start(): void {
    if (this.started) return;
    this.started = true;

    window.atrium.engine.onMessage((msg: EngineMsg) => {
      switch (msg.type) {
        case 'hello':
          useWorld.getState().applyHello(msg.world);
          break;
        case 'patch': {
          useWorld.getState().applyPatch(msg);
          if (useWorld.getState().desynced) this.post({ type: 'resync' });
          break;
        }
        case 'events':
          for (const event of msg.events) {
            for (const listener of this.eventListeners) listener(event);
          }
          break;
        case 'transcript': {
          const store = useTranscripts.getState();
          if (msg.reset) store.reset(msg.id, msg.append ?? [], msg.hasMore ?? false);
          else store.merge(msg.id, msg.append ?? [], msg.update ?? [], msg.hasMore ?? false);
          break;
        }
      }
    });

    window.atrium.window.onState(({ visible, focused }) => {
      this.post({ type: 'visibility', visible, focused });
    });

    void window.atrium.engine.connect();
  }

  post(msg: UiMsg): void {
    window.atrium.engine.post(msg);
  }

  /** Canvas LOD decides which cards stream; everything else is dropped. */
  subscribeTranscripts(ids: string[]): void {
    const next = ids.slice().sort().join('|');
    if (next === this.subscription) return;
    const previous = new Set(this.subscription ? this.subscription.split('|') : []);
    this.subscription = next;
    this.post({ type: 'subscribeTranscripts', ids, depth: 'tail' });

    const keep = new Set(ids);
    const stale = [...previous].filter((id) => id && !keep.has(id));
    if (stale.length) useTranscripts.getState().drop(stale);
  }

  onVisualEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
}

export const engineClient = new EngineClient();
