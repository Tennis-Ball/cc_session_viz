import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app, ipcMain, nativeImage, screen, Tray, type BrowserWindow, type Rectangle } from 'electron';
import { trayTitle, type GlanceCounts, type ViewMode } from '../shared/glance';
import { createTrayWindow, TRAY_POPOVER_SIZE } from './windows';

/**
 * The menu bar item and its popover.
 *
 * Main has no world of its own, so the counts arrive from the popover renderer
 * over IPC and this only formats and rate-limits them. The popover is created
 * hidden at mount and never destroyed: it is what keeps those counts coming
 * when the main window is closed.
 */

/** The menu bar is glanced at, not watched: once a second is plenty. */
const TITLE_INTERVAL_MS = 1000;
/** Gap between the menu bar item and the popover. */
const POPOVER_GAP = 4;
/**
 * Clicking the menu bar item blurs the popover before the click arrives here,
 * so a click that should close it would otherwise close and reopen it.
 */
const REOPEN_GUARD_MS = 250;

export interface TrayDeps {
  /** Whatever every renderer gets from main: prefs updates and window state. */
  onWindowCreated(win: BrowserWindow): void;
  /** Show the main window, optionally switching it to a mode first. */
  openMain(mode?: ViewMode): void;
}

export class AtriumTray {
  private tray: Tray | null = null;
  private popover: BrowserWindow | null = null;
  private shown = '';
  private shownAt = 0;
  private pending: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private dismissedAt = 0;

  constructor(private readonly deps: TrayDeps) {}

  mount(): void {
    if (this.tray) return;

    this.tray = new Tray(trayIcon());
    this.tray.setToolTip('Atrium');
    this.tray.setIgnoreDoubleClickEvents(true);
    this.tray.on('click', (_event, bounds) => this.toggle(bounds));

    ipcMain.on('tray:counts', (_event, counts: GlanceCounts) => this.setCounts(counts));
    ipcMain.on('tray:open-main', (_event, mode: ViewMode) => {
      this.hide();
      this.deps.openMain(mode);
    });

    // Warm it up hidden: the title has to be right before anyone clicks.
    this.window();
  }

  destroy(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    ipcMain.removeAllListeners('tray:counts');
    ipcMain.removeAllListeners('tray:open-main');
    this.tray?.destroy();
    this.tray = null;
    if (this.popover && !this.popover.isDestroyed()) this.popover.destroy();
    this.popover = null;
  }

  private setCounts(counts: GlanceCounts): void {
    const next = trayTitle(counts);
    if (next === this.shown) {
      this.pending = null;
      return;
    }
    this.pending = next;
    if (this.timer) return;

    const wait = Math.max(0, TITLE_INTERVAL_MS - (Date.now() - this.shownAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      const title = this.pending;
      this.pending = null;
      if (title === null || title === this.shown || !this.tray) return;
      this.shown = title;
      this.shownAt = Date.now();
      this.tray.setTitle(title);
    }, wait);
  }

  private window(): BrowserWindow {
    if (this.popover && !this.popover.isDestroyed()) return this.popover;
    const win = createTrayWindow();
    this.popover = win;
    // Clicking anywhere else dismisses it, the way every other popover behaves.
    win.on('blur', () => {
      this.dismissedAt = Date.now();
      win.hide();
    });
    this.deps.onWindowCreated(win);
    return win;
  }

  private toggle(bounds: Rectangle): void {
    const win = this.window();
    if (win.isVisible()) {
      win.hide();
      return;
    }
    if (Date.now() - this.dismissedAt < REOPEN_GUARD_MS) return;
    place(win, bounds);
    win.show();
    win.focus();
  }

  private hide(): void {
    if (this.popover && !this.popover.isDestroyed()) this.popover.hide();
  }
}

/** Centred under the menu bar item, kept inside the display it belongs to. */
function place(win: BrowserWindow, bounds: Rectangle): void {
  const { width, height } = TRAY_POPOVER_SIZE;
  const area = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea;
  const centred = bounds.x + bounds.width / 2 - width / 2;
  const leftLimit = area.x + POPOVER_GAP;
  const rightLimit = area.x + area.width - width - POPOVER_GAP;
  const x = Math.round(Math.min(Math.max(centred, leftLimit), rightLimit));
  const y = Math.round(bounds.y + bounds.height + POPOVER_GAP);
  win.setBounds({ x, y, width, height });
}

/**
 * Black-and-alpha only, so macOS can tint it. `createFromPath` picks up the
 * adjacent `@2x` file by itself, which is the whole reason for that naming.
 */
function trayIcon(): Electron.NativeImage {
  const file = resolveResource('trayTemplate.png');
  const image = file ? nativeImage.createFromPath(file) : nativeImage.createEmpty();
  image.setTemplateImage(true);
  return image;
}

function resolveResource(name: string): string | null {
  const roots = [
    join(app.getAppPath(), 'resources'), // dev, and inside the asar
    join(process.resourcesPath, 'resources'), // packaged as an extra resource
    join(__dirname, '../../resources'), // out/main, running from the repo
  ];
  for (const root of roots) {
    const file = join(root, name);
    if (existsSync(file)) return file;
  }
  console.error(`[tray] ${name} not found; the menu bar item will be blank`);
  return null;
}
