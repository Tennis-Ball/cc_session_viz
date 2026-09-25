import { app, BrowserWindow, ipcMain } from 'electron';
import type { ViewMode } from '../shared/glance';
import { EngineHost } from './engineHost';
import { logMainError, registerErrorLog } from './errorLog';
import { PrefsStore } from './prefsStore';
import { AtriumTray } from './tray';
import { createMainWindow } from './windows';

const prefs = new PrefsStore();
const engine = new EngineHost(() => prefs.read().mode);
const tray = new AtriumTray({
  onWindowCreated: (win) => {
    prefs.subscribe(win.webContents);
    forwardWindowState(win);
  },
  openMain: (mode) => openMainWindow(mode),
});

let mainWindow: BrowserWindow | null = null;

/**
 * Background runs never become the frontmost app.
 *
 * This has to happen here, at module scope, rather than inside `whenReady`.
 * macOS activates an app as it launches; by the time the ready event fires the
 * app is already in front, and hiding the dock icon then only takes the icon
 * away — the window still arrives over whatever you were doing. Hiding it
 * before the app finishes launching means it never becomes a regular
 * application at all, which is what `showInactive` needs to be worth anything.
 *
 * Iterating on the office means opening it dozens of times, and doing that in
 * front of whoever is using the machine is intolerable.
 */
if (process.env['CCV_BACKGROUND'] !== undefined) {
  app.dock?.hide();
  app.setActivationPolicy?.('accessory');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openMainWindow());

  void app.whenReady().then(() => {
    app.setName('Atrium');
    prefs.register();
    registerErrorLog();
    engine.start();

    // The renderer asks for its port once its client is ready, which keeps the
    // handshake correct across reloads and engine restarts.
    ipcMain.handle('engine:connect', (event) => {
      engine.connect(event.sender);
      return true;
    });

    // The window comes first: the tray keeps a hidden popover alive, and that
    // must never be the app's first window.
    openMainWindow();
    // The menu bar item is a macOS shape: a template image and a title beside it.
    if (process.platform === 'darwin') tray.mount();

    app.on('activate', () => openMainWindow());
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    prefs.flush();
    engine.stop();
    tray.destroy();
  });
}

/**
 * The main window, reused if it is still around. The tray opens it too, which
 * is why switching mode waits for the load when the window is brand new.
 */
function openMainWindow(mode?: ViewMode): void {
  const win = showMainWindow();
  if (!mode) return;
  const send = (): void => win.webContents.send('ui-mode', mode);
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

function showMainWindow(): BrowserWindow {
  const existing = mainWindow;
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return existing;
  }

  const win = createMainWindow();
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  prefs.subscribe(win.webContents);
  forwardWindowState(win);
  return win;
}

/** Visibility drives the engine's flush cadence, so it has to reach the renderer. */
function forwardWindowState(win: BrowserWindow): void {
  const send = () => {
    if (win.isDestroyed()) return;
    win.webContents.send('window-state', {
      visible: win.isVisible() && !win.isMinimized(),
      focused: win.isFocused(),
    });
  };
  win.on('focus', send);
  win.on('blur', send);
  win.on('show', send);
  win.on('hide', send);
  win.on('minimize', send);
  win.on('restore', send);
  win.webContents.on('did-finish-load', send);
}
