import { app, ipcMain, type WebContents } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { applyPatch, mergePrefs, type Prefs, type PrefsPatch } from '../shared/prefs';

/**
 * Prefs on disk.
 *
 * Written atomically (temp file plus rename) because a half-written prefs file
 * read at the next launch is how an app loses every setting at once. Writes are
 * debounced: the camera and canvas viewport change constantly.
 *
 * This is the **only** thing the app writes anywhere. It never touches
 * `~/.claude`.
 */

const WRITE_DEBOUNCE_MS = 400;

export class PrefsStore {
  private cache: Prefs | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly subscribers = new Set<WebContents>();

  get path(): string {
    return join(app.getPath('userData'), 'prefs.json');
  }

  read(): Prefs {
    if (this.cache) return this.cache;
    try {
      this.cache = mergePrefs(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch {
      // Missing or corrupt: start from defaults rather than refusing to launch.
      this.cache = mergePrefs(null);
    }
    return this.cache;
  }

  update(patch: PrefsPatch): Prefs {
    /*
     * Cleaned on the way in, not only on the way off disk.
     *
     * `applyPatch` is a shallow merge and believes whatever it is handed, and
     * until now the only thing that checked a value was the *loader*. So a
     * patch carrying a setting the app no longer has — `office.detail:
     * 'composed'`, retired two rounds ago and still being set by a test —
     * went straight into the cache and straight out to every renderer, where
     * `STACKS[detail]` came back undefined and the office died with "Cannot
     * read properties of undefined". Restarting fixed it, which is the worst
     * kind of bug: the file was sanitised on the next read, so the evidence
     * cleaned itself up.
     *
     * One pass through the same function that cleans the file. Nothing invalid
     * can reach a renderer, whoever wrote it and however it got here.
     */
    const next = mergePrefs(applyPatch(this.read(), patch));
    this.cache = next;
    this.scheduleWrite();
    this.broadcast(next);
    return next;
  }

  /** Registers the IPC surface and keeps renderers in sync with each other. */
  register(): void {
    ipcMain.handle('prefs:get', () => this.read());
    ipcMain.handle('prefs:set', (event, patch: PrefsPatch) => {
      this.subscribers.add(event.sender);
      event.sender.once('destroyed', () => this.subscribers.delete(event.sender));
      return this.update(patch);
    });
  }

  subscribe(contents: WebContents): void {
    this.subscribers.add(contents);
    contents.once('destroyed', () => this.subscribers.delete(contents));
  }

  /** Called on quit: whatever is pending has to land before the process goes. */
  flush(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.writeNow();
  }

  private scheduleWrite(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writeNow();
    }, WRITE_DEBOUNCE_MS);
  }

  private writeNow(): void {
    if (!this.cache) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(this.cache, null, 2)}\n`, 'utf8');
      renameSync(temp, this.path);
    } catch {
      // A settings write failing is not worth interrupting anybody over.
    }
  }

  private broadcast(prefs: Prefs): void {
    for (const contents of this.subscribers) {
      if (!contents.isDestroyed()) contents.send('prefs-changed', prefs);
    }
  }
}
