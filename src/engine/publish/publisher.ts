import { EVENT_BATCH_MS, FLUSH_MS, PROTOCOL_VERSION, type EngineMsg, type UiMsg } from '../../shared/protocol';
import type { WorldStore } from '../state/worldStore';

interface Connection {
  port: Electron.MessagePortMain;
  visible: boolean;
  focused: boolean;
  transcripts: Set<string>;
}

export type UiMsgHandler = (msg: UiMsg, connection: { transcripts: Set<string> }) => void;

/**
 * Fans world patches and visual events out to every connected renderer.
 *
 * Cadence follows window state: 10 Hz focused, 2 Hz visible, 0.5 Hz hidden.
 * Events are dropped entirely while every window is hidden, because the world
 * state alone is enough to rebuild the view.
 */
export class Publisher {
  private readonly connections = new Set<Connection>();
  private patchTimer: NodeJS.Timeout | null = null;
  private eventTimer: NodeJS.Timeout | null = null;
  private currentFlushMs: number = FLUSH_MS.visible;

  constructor(
    private readonly store: WorldStore,
    private readonly onUiMsg: UiMsgHandler = () => {},
  ) {}

  start(): void {
    this.scheduleFlush();
    this.eventTimer = setInterval(() => this.flushEvents(), EVENT_BATCH_MS);
  }

  stop(): void {
    if (this.patchTimer) clearInterval(this.patchTimer);
    if (this.eventTimer) clearInterval(this.eventTimer);
    this.patchTimer = null;
    this.eventTimer = null;
  }

  addConnection(port: Electron.MessagePortMain): void {
    const connection: Connection = { port, visible: true, focused: true, transcripts: new Set() };
    this.connections.add(connection);

    port.on('message', (event: Electron.MessageEvent) => {
      const msg = event.data as UiMsg;
      switch (msg.type) {
        case 'visibility':
          connection.visible = msg.visible;
          connection.focused = msg.focused;
          this.scheduleFlush();
          break;
        case 'subscribeTranscripts':
          connection.transcripts = new Set(msg.ids);
          this.onUiMsg(msg, connection);
          break;
        case 'resync':
          this.sendHello(connection);
          break;
        default:
          this.onUiMsg(msg, connection);
      }
    });

    port.on('close', () => this.connections.delete(connection));
    port.start();
    this.sendHello(connection);
  }

  /** Any renderer that is at least visible; used to decide whether events matter. */
  get anyVisible(): boolean {
    for (const c of this.connections) if (c.visible) return true;
    return false;
  }

  /** Read by the usage poller, which only calls the API for a live window. */
  get anyFocused(): boolean {
    for (const c of this.connections) if (c.focused) return true;
    return false;
  }

  private sendHello(connection: Connection): void {
    const msg: EngineMsg = { type: 'hello', protocol: PROTOCOL_VERSION, world: this.store.snapshot() };
    connection.port.postMessage(msg);
  }

  private scheduleFlush(): void {
    const next = this.anyFocused ? FLUSH_MS.focused : this.anyVisible ? FLUSH_MS.visible : FLUSH_MS.hidden;
    if (next === this.currentFlushMs && this.patchTimer) return;
    this.currentFlushMs = next;
    if (this.patchTimer) clearInterval(this.patchTimer);
    this.patchTimer = setInterval(() => this.flushPatch(), next);
  }

  private flushPatch(): void {
    if (this.connections.size === 0) return;
    const patch = this.store.drainPatch();
    if (!patch) return;
    for (const c of this.connections) c.port.postMessage(patch);
  }

  private flushEvents(): void {
    const events = this.store.drainEvents();
    if (events.length === 0 || !this.anyVisible) return;
    const msg: EngineMsg = { type: 'events', events };
    for (const c of this.connections) if (c.visible) c.port.postMessage(msg);
  }

  broadcast(msg: EngineMsg): void {
    for (const c of this.connections) c.port.postMessage(msg);
  }
}
