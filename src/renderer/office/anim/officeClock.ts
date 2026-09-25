/**
 * The office's own clock, in milliseconds.
 *
 * Everything that animates — walks, beats, attention windows, the rolling
 * window a figure uses to pick a zone — is timed against this rather than
 * against `performance.now()`, because the office does not always run.
 *
 * It is not drawn while the window is hidden or while the canvas is the mode in
 * front, and both of those can last hours. Wall-clock time keeps going, so on
 * the frame the office comes back every controller is handed a `now` that jumped
 * an hour while its `delta` is clamped to a tenth of a second: every rolling
 * window has expired at once, every beat has overrun, and the whole office
 * re-decides where it is going while moving a fraction of a step. That is a
 * visible lurch on the first frame after every mode switch.
 *
 * Advancing it by the frame delta instead means the pause simply does not exist
 * from inside. A figure mid-stride when you left resumes mid-stride, because as
 * far as it is concerned no time passed. The delta is clamped by the caller, so
 * a long stall cannot teleport anyone either.
 */

let elapsed = 0;

/** Milliseconds of office time. Monotonic, and frozen whenever it is not drawn. */
export function officeNow(): number {
  return elapsed;
}

/** Advances the clock by one frame. `delta` is in seconds, already clamped. */
export function advanceOfficeClock(delta: number): void {
  elapsed += delta * 1000;
}
