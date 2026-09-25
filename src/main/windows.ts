import { join } from 'node:path';
import { BrowserWindow, shell } from 'electron';

const DEV_SERVER = process.env['ELECTRON_RENDERER_URL'];

/**
 * Open without taking the screen.
 *
 * Set while iterating on the office: a screenshot run has to put a real window
 * on a real GPU — there is no offscreen path that renders WebGL the same way —
 * but it has nothing to say to whoever is using the machine. The window still
 * appears and still draws; it just never steals focus and never bounces the
 * dock. `backgroundThrottling` goes off with it, because macOS throttles the
 * frame loop of a window that is not in front and a throttled office animates
 * at about two frames a second.
 */
const BACKGROUND = process.env['CCV_BACKGROUND'] !== undefined;

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Atrium',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#0b0b0d',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: !BACKGROUND,
    },
  });

  win.once('ready-to-show', () => (BACKGROUND ? win.showInactive() : win.show()));

  // Any link in the UI opens in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (DEV_SERVER) {
    void win.loadURL(DEV_SERVER);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return win;
}

export const TRAY_POPOVER_SIZE = { width: 340, height: 460 } as const;

/**
 * The menu bar popover: the same renderer bundle, routed by `#tray`.
 *
 * It is created once and kept alive hidden, because it is the only renderer
 * that is always around to tell main what the sessions are doing — the main
 * window may well be closed. Hence no background throttling: a menu bar count
 * that lags a minute behind is worse than no count.
 */
export function createTrayWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...TRAY_POPOVER_SIZE,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#0b0b0d',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  // A menu bar popover belongs to the menu bar, not to one desktop.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (DEV_SERVER) {
    void win.loadURL(`${DEV_SERVER}#tray`);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'tray' });
  }

  return win;
}
