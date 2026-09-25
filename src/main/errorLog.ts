import { app, ipcMain } from 'electron';
import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * A crash log next to the prefs file.
 *
 * Renderer crashes are intermittent by nature: by the time anyone looks, the
 * window has been reloaded and the console is gone. One rolling file is enough
 * to tell later what actually happened, and it is the only other thing this app
 * ever writes.
 */

const MAX_BYTES = 256 * 1024;

export interface RendererError {
  area: string;
  message: string;
  stack: string;
  componentStack: string;
}

export function registerErrorLog(): void {
  ipcMain.handle('log:error', (_event, error: RendererError) => {
    write(
      [
        `[${new Date().toISOString()}] renderer/${error.area}: ${error.message}`,
        error.stack,
        error.componentStack,
      ]
        .filter(Boolean)
        .join('\n'),
    );
    return true;
  });
}

/** Also used by main itself, for engine and window failures. */
export function logMainError(context: string, detail: unknown): void {
  const message = detail instanceof Error ? `${detail.message}\n${detail.stack ?? ''}` : String(detail);
  write(`[${new Date().toISOString()}] main/${context}: ${message}`);
}

export function errorLogPath(): string {
  return join(app.getPath('userData'), 'errors.log');
}

function write(entry: string): void {
  try {
    const path = errorLogPath();
    mkdirSync(dirname(path), { recursive: true });
    // Roll once rather than growing without bound; two files is plenty of history.
    try {
      if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`);
    } catch {
      // No file yet, which is the normal case.
    }
    appendFileSync(path, `${entry}\n\n`, 'utf8');
  } catch {
    // Failing to log must never be the thing that breaks the app.
  }
}
