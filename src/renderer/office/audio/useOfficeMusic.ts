import { useEffect, useRef } from 'react';
import { usePrefs } from '../../store/prefs';
import { useWorld } from '../../store/world';
import { dayFactorFor } from '../theme/themes';
import { officeMusic } from './music';

/**
 * The music layer, tied to prefs, the clock and how busy the office is.
 *
 * It lives at the top of the app rather than inside the office: the piece
 * should carry across a mode switch, not restart every time you look at the
 * canvas.
 */
export function useOfficeMusic(): void {
  const enabled = usePrefs((s) => s.prefs.sound.enabled);
  const volume = usePrefs((s) => s.prefs.sound.master);
  const pinnedClock = usePrefs((s) => s.prefs.theme.pinnedClock);
  const visible = useRef(true);

  useEffect(() => {
    return window.atrium.window.onState((state) => {
      visible.current = state.visible;
      if (!state.visible) officeMusic.stop();
      else if (usePrefs.getState().prefs.sound.enabled) officeMusic.start();
    });
  }, []);

  useEffect(() => {
    if (enabled && visible.current) officeMusic.start();
    else officeMusic.stop();
  }, [enabled]);

  // One update a second: the piece moves on its own, this only steers it.
  useEffect(() => {
    if (!enabled) return;
    const tick = (): void => {
      const sessions = Object.values(useWorld.getState().world.sessions);
      const working = sessions.filter((session) => session.phase === 'working').length;
      officeMusic.update({
        volume,
        dayFactor: dayFactorFor(clockNow(pinnedClock)),
        intensity: sessions.length === 0 ? 0 : working / sessions.length,
      });
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [enabled, volume, pinnedClock]);

  useEffect(() => () => officeMusic.dispose(), []);
}

/** The same pinned-hour rule the office lighting follows. */
function clockNow(pinned: string | null): Date {
  const override = new URLSearchParams(window.location.search).get('clock') ?? pinned;
  if (!override) return new Date();
  const date = new Date();
  const [hours, minutes] = override.split(':');
  date.setHours(Number(hours ?? 12), Number(minutes ?? 0), 0, 0);
  return date;
}
