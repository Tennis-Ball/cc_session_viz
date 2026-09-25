import { join } from 'node:path';
import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron';

/**
 * Owns the engine utility process and hands each renderer a direct MessagePort
 * to it, so transcript parsing never runs on the main thread. If the engine
 * dies, it is restarted and every live renderer is re-connected.
 */
export class EngineHost {
  private child: UtilityProcess | null = null;
  private readonly clients = new Set<WebContents>();
  private restarts = 0;
  private stopping = false;

  /**
   * `mode` is asked for at every (re)start rather than captured once, because
   * the engine can be restarted after a crash and has to come back up showing
   * the same world it went down showing.
   */
  constructor(
    private readonly mode: () => string,
    private readonly entry = join(__dirname, 'engine.js'),
  ) {}

  start(): void {
    if (this.child) return;
    const child = utilityProcess.fork(this.entry, [], {
      serviceName: 'atrium-engine',
      stdio: 'pipe',
      // The engine has to know which world to show *before* it starts a
      // source. Left to the renderer to tell it, there was a window at every
      // launch in which a simulation-mode office was served real sessions.
      env: { ...process.env, CCV_MODE_REMEMBERED: this.mode() },
    });
    this.child = child;

    child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[engine] ${chunk}`));
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[engine] ${chunk}`));

    child.on('exit', (code) => {
      this.child = null;
      if (this.stopping) return;
      this.restarts += 1;
      const delay = Math.min(5000, 250 * this.restarts);
      console.error(`[main] engine exited (${code}); restarting in ${delay}ms`);
      setTimeout(() => {
        if (this.stopping) return;
        this.start();
        for (const wc of this.clients) this.connect(wc);
      }, delay);
    });
  }

  stop(): void {
    this.stopping = true;
    this.child?.kill();
    this.child = null;
  }

  /** Give this renderer its own port to the engine. Safe to call again on reload. */
  connect(wc: WebContents): void {
    if (!this.child) this.start();
    if (!this.child || wc.isDestroyed()) return;

    if (!this.clients.has(wc)) {
      this.clients.add(wc);
      wc.once('destroyed', () => this.clients.delete(wc));
    }

    const { port1, port2 } = new MessageChannelMain();
    this.child.postMessage({ type: 'connect-ui' }, [port1]);
    wc.postMessage('engine-port', null, [port2]);
  }
}
