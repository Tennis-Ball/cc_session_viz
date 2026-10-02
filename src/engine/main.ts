import { Publisher } from './publish/publisher';
import { TranscriptHub } from './publish/transcriptHub';
import { AmbientSource } from './sources/ambient';
import { LiveSource } from './sources/live';
import type { DataMode } from '../shared/model';
import { WorldStore } from './state/worldStore';
import { UsageMonitor } from './usage/monitor';

/**
 * Engine entry point. Runs in an Electron utilityProcess so parsing never
 * blocks window management, and a crash here only costs a restart.
 */

const store = new WorldStore();
const spec = process.env['CCV_SOURCE'] ?? 'live';
const live = spec.startsWith('live') ? new LiveSource(store) : null;
const simulation = new AmbientSource(store);

/**
 * Two modes, and only ever one of them running.
 *
 * They are exclusive on purpose: the simulation is a generated office that must
 * never contain, borrow from, or sit alongside a real session. Mixing them
 * would mean never being quite sure whether what you are watching is yours.
 */
/**
 * `CCV_MODE` pins it; otherwise main passes on what was remembered.
 *
 * The remembered mode used to arrive from the *renderer*, after prefs had
 * hydrated and the port had connected — several hundred milliseconds during
 * which the engine had already started reading `~/.claude` and shipped a first
 * snapshot of real sessions to somebody who had asked for the simulation.
 * Knowing it before anything starts is the only way that window closes.
 */
let mode: DataMode =
  (process.env['CCV_MODE'] as DataMode | undefined) ??
  (process.env['CCV_MODE_REMEMBERED'] as DataMode | undefined) ??
  (live ? 'real' : 'simulation');

const publisher = new Publisher(store, (msg) => {
  if (msg.type === 'subscribeTranscripts') hub.setSubscriptions(msg.ids);
  if (msg.type === 'setDataMode') setMode(msg.mode);
  if (msg.type === 'setOptions') {
    live?.setOptions({ hideSdkSessions: msg.hideSdkSessions, endedGraceMs: msg.endedGraceMs });
  }
});

/**
 * Under test the panel asks nothing of anybody: no Keychain prompt to hang a
 * run, no network call to flake it, and no real account numbers in a shot.
 */
const usageOffline = process.env['CCV_TEST'] !== undefined;
// Real limits are only worth asking for while somebody is watching them.
const usage = new UsageMonitor(store, {
  isFocused: () => publisher.anyFocused,
  offline: usageOffline,
});

const hub = new TranscriptHub(publisher, () => ({
  // Whichever source is the one running. Asking the live source first
  // regardless of mode meant a card left over from a mode switch could still
  // stream real transcript text into a simulated office.
  logFor: (cardId: string) =>
    mode === 'simulation' ? simulation.logFor(cardId) : (live?.logFor?.(cardId) ?? simulation.logFor(cardId)),
}));

store.patchHealth({
  source: live ? 'live' : 'sim',
  mode,
  modeLocked: process.env['CCV_MODE'] !== undefined,
  simSeed: simulation.seed,
});
publisher.start();
hub.start();
simulation.start();
usage.start();
applyMode();

function setMode(next: DataMode): void {
  if (next === mode) return;
  mode = next;
  applyMode();
}

/**
 * Only one source is ever live. Switching tears the other one down completely
 * rather than hiding it, so nothing from the previous mode can linger.
 */
function applyMode(): void {
  store.patchHealth({ mode });
  // Before either source is touched: the store then refuses anything from the
  // other one, including whatever was already in flight when the switch came.
  store.setMode(mode);
  if (mode === 'simulation' || !live) {
    live?.reset();
    simulation.setActive(true);
  } else {
    simulation.setActive(false);
    void live.start();
  }
}

const parentPort = process.parentPort;
parentPort?.on('message', (event) => {
  const data = event.data as { type?: string } | undefined;
  if (data?.type === 'connect-ui') {
    const port = event.ports[0];
    if (port) publisher.addConnection(port);
  }
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void live?.stop();
    simulation.stop();
    usage.stop();
    hub.stop();
    publisher.stop();
    process.exit(0);
  });
}
