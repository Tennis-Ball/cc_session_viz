import { useEffect, useRef } from 'react';
import { usePrefs } from '../../store/prefs';
import { useWorld } from '../../store/world';
import { dayFactorFor } from '../theme/themes';
/*
 * Loaded the first time sound is switched on, not at startup.
 *
 * The synthesiser is the better part of a thousand lines and it is off by
 * default, so for almost everyone it was a kilobyte-for-kilobyte pure cost on
 * the path to first paint. `import()` keeps it out of the opening chunk and
 * costs one await the first time somebody wants music.
 */
type Music = typeof import('./music')['officeMusic'];
let loading: Promise<Music> | null = null;
let loaded: Music | null = null;

function music(): Promise<Music> {
  loading ??= import('./music').then((module) => {
    loaded = module.officeMusic;
    return loaded;
  });
  return loading;
}

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
      // Only ever *stops* what is already loaded: a hidden window is not a
      // reason to go and fetch a synthesiser.
      if (!state.visible) loaded?.stop();
      else if (usePrefs.getState().prefs.sound.enabled) void music().then((m) => m.start());
    });
  }, []);

  useEffect(() => {
    if (enabled && visible.current) void music().then((m) => m.start());
    else loaded?.stop();
  }, [enabled]);

  // One update a second: the piece moves on its own, this only steers it.
  useEffect(() => {
    if (!enabled) return;
    const tick = (): void => {
      const sessions = Object.values(useWorld.getState().world.sessions);
      const working = sessions.filter((session) => session.phase === 'working').length;
      loaded?.update({
        volume,
        dayFactor: dayFactorFor(clockNow(pinnedClock)),
        intensity: sessions.length === 0 ? 0 : working / sessions.length,
      });
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [enabled, volume, pinnedClock]);

  useEffect(() => () => loaded?.dispose(), []);
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
