import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

const ROOT = resolve(__dirname, '../..');

export interface LaunchOptions {
  /** Data source spec, e.g. "sim:showcase" or "live". */
  source?: string;
  /** Extra environment for deterministic runs (seeds, pinned clock). */
  env?: Record<string, string>;
  /**
   * Query parameters the renderer reads at mount: `probe`, `clock`, `seed`.
   *
   * These have to be in place *before* the office mounts, so setting them means
   * a reload — done here rather than in each test.
   *
   * Tests used to set them with `replaceState` and then get the office to pick
   * them up by clicking Canvas and Office again, because switching modes
   * unmounted and rebuilt the whole view. That is fixed: the office now stays
   * mounted and keeps its WebGL context. So the trick quietly stopped installing
   * the probe, and every assertion that depended on it started passing over an
   * empty object. Asking at launch cannot rot the same way.
   */
  query?: Record<string, string>;
}

export async function launchApp(options: LaunchOptions = {}): Promise<{ app: ElectronApplication; page: Page }> {
  // Its own prefs directory per run: screenshots have to be reproducible, and a
  // test must never inherit — or overwrite — the settings you are actually using.
  const userData = mkdtempSync(join(tmpdir(), 'atrium-e2e-'));

  const app = await electron.launch({
    args: [resolve(ROOT, 'out/main/index.js'), `--user-data-dir=${userData}`],
    cwd: ROOT,
    env: {
      ...process.env,
      CCV_TEST: '1',
      // Every screenshot run opens a window; none of them should interrupt
      // whoever is using the machine. See `main/windows.ts`.
      CCV_BACKGROUND: '1',
      CCV_SOURCE: options.source ?? 'sim:showcase',
      ...options.env,
    },
  });
  const page = await mainWindow(app);
  await page.waitForLoadState('domcontentloaded');
  OWNER.set(page, app);
  if (options.query) {
    await page.evaluate((query) => {
      const url = new URL(window.location.href);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      window.history.replaceState({}, '', url.toString());
    }, options.query);
    await page.reload();
    await page.locator('.titlebar').waitFor();
  }
  return { app, page };
}

/**
 * Which app a page belongs to.
 *
 * `shoot` needs the Electron application, not the page, because the screenshot
 * is taken in the main process (see below) — and every caller already passes
 * the page. Rather than change thirty call sites to thread the app through,
 * remember the pairing when the app is launched.
 */
const OWNER = new WeakMap<Page, ElectronApplication>();

/**
 * The app opens more than one window (the tray popover is a window too), and
 * `firstWindow()` returns whichever raced to exist first. Tests always mean the
 * main one, which is the one carrying the title bar.
 */
async function mainWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
      const url = candidate.url();
      if (url.includes('#tray')) continue;
      if (await candidate.locator('.titlebar').count()) return candidate;
    }
    await app.firstWindow();
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return app.firstWindow();
}

/**
 * Screenshots land in artifacts/shots/ for eyeballing during development.
 *
 * Taken by the main process, not by Playwright. `page.screenshot()` goes
 * through CDP, and CDP brings a page to the front before it captures —  so a
 * run that shoots eight frames punched the office to the front of whoever was
 * using the machine eight times, however carefully the window was opened
 * inactive. `webContents.capturePage()` reads the same window's compositor
 * output and has no opinion about focus.
 */
export async function shoot(page: Page, name: string): Promise<void> {
  const app = OWNER.get(page);
  if (!app) throw new Error(`shoot(${name}): the page was not opened by launchApp`);

  const encoded = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.webContents.getURL().includes('#tray'));
    if (!win) throw new Error('no main window to capture');
    return (await win.webContents.capturePage()).toPNG().toString('base64');
  });

  // Created on demand: the directory is a build artifact, so it is routinely
  // cleared out, and a whole screenshot run failing on the first shot because
  // nothing made the folder is a waste of ten minutes.
  const into = resolve(ROOT, 'artifacts/shots');
  mkdirSync(into, { recursive: true });
  writeFileSync(resolve(into, `${name}.png`), Buffer.from(encoded, 'base64'));
}

/**
 * A keystroke, delivered without taking the keyboard.
 *
 * `page.keyboard.press()` focuses the window first, which is the one thing
 * these runs must never do. Sending the event straight to the web contents
 * reaches the same listeners.
 */
export async function press(page: Page, key: string): Promise<void> {
  const app = OWNER.get(page);
  if (!app) throw new Error(`press(${key}): the page was not opened by launchApp`);

  await app.evaluate(async ({ BrowserWindow }, pressed: string) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.webContents.getURL().includes('#tray'));
    if (!win) throw new Error('no main window to type into');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: pressed });
    win.webContents.sendInputEvent({ type: 'char', keyCode: pressed });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: pressed });
  }, key);
}
