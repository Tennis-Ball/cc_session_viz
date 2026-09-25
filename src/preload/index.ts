import { contextBridge, ipcRenderer } from 'electron';
import type { GlanceCounts, ViewMode } from '../shared/glance';
import type { EngineMsg, UiMsg } from '../shared/protocol';
import type { Prefs, PrefsPatch } from '../shared/prefs';

/**
 * The MessagePort itself can't cross the context bridge, so the preload keeps it
 * and exposes plain functions. Messages are structured-cloned data only.
 */

type EngineListener = (msg: EngineMsg) => void;
type WindowStateListener = (state: { visible: boolean; focused: boolean }) => void;
type ModeListener = (mode: ViewMode) => void;
type PrefsListener = (prefs: Prefs) => void;
/** Derived from Electron's event so the preload needs no DOM lib in tsconfig. */
type RendererPort = Electron.IpcRendererEvent['ports'][number];

let port: RendererPort | null = null;
const queued: UiMsg[] = [];
const listeners = new Set<EngineListener>();
const windowStateListeners = new Set<WindowStateListener>();
const modeListeners = new Set<ModeListener>();
const prefsListeners = new Set<PrefsListener>();

ipcRenderer.on('engine-port', (event) => {
  port?.close();
  const next = event.ports[0];
  if (!next) return;
  port = next;
  next.onmessage = (ev: { data: unknown }) => {
    const msg = ev.data as EngineMsg;
    for (const listener of listeners) listener(msg);
  };
  next.start();
  while (queued.length) next.postMessage(queued.shift());
});

ipcRenderer.on('window-state', (_event, state: { visible: boolean; focused: boolean }) => {
  for (const listener of windowStateListeners) listener(state);
});

ipcRenderer.on('ui-mode', (_event, mode: ViewMode) => {
  for (const listener of modeListeners) listener(mode);
});

ipcRenderer.on('prefs-changed', (_event, prefs: Prefs) => {
  for (const listener of prefsListeners) listener(prefs);
});

const api = {
  engine: {
    /** Ask the main process for a fresh port; resolves once it has been requested. */
    connect: (): Promise<boolean> => ipcRenderer.invoke('engine:connect'),
    post: (msg: UiMsg): void => {
      if (port) port.postMessage(msg);
      else queued.push(msg);
    },
    onMessage: (listener: EngineListener): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
  window: {
    onState: (listener: WindowStateListener): (() => void) => {
      windowStateListeners.add(listener);
      return () => windowStateListeners.delete(listener);
    },
    /** The tray switches the main window's mode; the store applies it. */
    onMode: (listener: ModeListener): (() => void) => {
      modeListeners.add(listener);
      return () => modeListeners.delete(listener);
    },
  },
  tray: {
    /** Only a renderer has a world, so the menu bar title starts here. */
    report: (counts: GlanceCounts): void => ipcRenderer.send('tray:counts', counts),
    openMain: (mode: ViewMode): void => ipcRenderer.send('tray:open-main', mode),
  },
  prefs: {
    get: (): Promise<Prefs> => ipcRenderer.invoke('prefs:get'),
    set: (patch: PrefsPatch): Promise<Prefs> => ipcRenderer.invoke('prefs:set', patch),
    onChange: (listener: PrefsListener): (() => void) => {
      prefsListeners.add(listener);
      return () => prefsListeners.delete(listener);
    },
  },
  log: {
    error: (error: { area: string; message: string; stack: string; componentStack: string }): Promise<boolean> =>
      ipcRenderer.invoke('log:error', error),
  },
  platform: process.platform,
};

export type AtriumApi = typeof api;

contextBridge.exposeInMainWorld('atrium', api);
