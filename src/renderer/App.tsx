import { lazy, Suspense, useEffect, useState } from 'react';
/*
 * The canvas arrives when you first ask for it.
 *
 * The app opens in the office, and the whole board — React Flow, the TUI
 * formatters, the usage panel — was in the opening chunk regardless. Splitting
 * it is worth more here than in a web app: the renderer bundle is read off
 * disk at launch and parsed before the first frame of a scene that is the
 * reason the app exists.
 */
const CanvasView = lazy(() => import('./canvas/CanvasView').then((m) => ({ default: m.CanvasView })));
import { OfficeView } from './office/OfficeView';
import { EmptyState } from './chrome/EmptyState';
import { ErrorBoundary } from './chrome/ErrorBoundary';
import { TitleBar } from './chrome/TitleBar';
import { engineClient } from './engine/client';
import { useOfficeMusic } from './office/audio/useOfficeMusic';
import { Settings } from './shared-ui/Settings';
import { usePrefs } from './store/prefs';
import { useUi, type ViewMode } from './store/ui';
import { Inspector } from './views/Inspector';

/** ⌘1…⌘2. Must match the title bar's order. */
const MODE_KEYS: ViewMode[] = ['office', 'canvas'];

export function App(): React.JSX.Element {
  const mode = useUi((s) => s.mode);
  const setMode = useUi((s) => s.setMode);
  const inspectorOpen = useUi((s) => s.inspectorOpen);
  const hydrate = usePrefs((s) => s.hydrate);
  const hideSdkSessions = usePrefs((s) => s.prefs.hideSdkSessions);
  const endedGraceMs = usePrefs((s) => s.prefs.endedGraceMs);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useOfficeMusic();
  useEffect(() => engineClient.start(), []);
  useEffect(() => void hydrate(), [hydrate]);

  // Two settings decide which sessions exist rather than how they are drawn,
  // so the engine has to hear about them. Sent from here because this is the
  // one component that outlives every mode switch.
  useEffect(() => {
    engineClient.setOptions({ hideSdkSessions, endedGraceMs });
  }, [hideSdkSessions, endedGraceMs]);

  /*
   * Reduced motion follows the system, and only the system.
   *
   * There was a three-way setting in front of this. Nobody needs an app-level
   * override for an accessibility preference they have already expressed once,
   * in the place macOS asks for it — and the two extra options existed mostly
   * to let somebody put the app out of step with the rest of their machine.
   * CSS keys off the attribute, and the office reads the same one rather than
   * threading a prop through the scene.
   */
  useEffect(() => {
    const system = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = (): void => {
      document.documentElement.dataset['motion'] = system.matches ? 'reduced' : 'full';
    };
    apply();
    system.addEventListener('change', apply);
    return () => system.removeEventListener('change', apply);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey) return;
      // ⌘1…⌘2, in the order the title bar shows them.
      const index = Number(e.key);
      if (Number.isInteger(index) && index >= 1 && index <= MODE_KEYS.length) {
        setMode(MODE_KEYS[index - 1]!);
      }
      if (e.key === ',') {
        e.preventDefault();
        setSettingsOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setMode]);

  return (
    <div className="app">
      <TitleBar onOpenSettings={() => setSettingsOpen(true)} />
      <main className="stage">
        {/*
         * The office stays mounted for the life of the window, and is hidden
         * rather than removed when you switch modes.
         *
         * It used to be `mode === 'canvas' ? <CanvasView/> : <OfficeView/>`,
         * which threw away the WebGL context on every ⌘1/⌘2 and built a new one
         * coming back: a black frame, then a whole campus replanned, every
         * building re-merged and every figure respawned, several times a second
         * if you tab back and forth. Browsers also cap live contexts and drop
         * the oldest to stay under it, so churning them is a good way to have
         * the office go black on its own and stay black. The context is the one
         * expensive thing here and it is now created once.
         *
         * The canvas has no context and subscribes to transcripts for whatever
         * cards are on screen, so it is still mounted only while it is the mode
         * you are looking at — keeping it alive in the background would keep
         * that subscription alive with it, for nothing.
         */}
        <div className="stage__layer" data-active={mode === 'office'} aria-hidden={mode !== 'office'}>
          <ErrorBoundary area="office">
            <OfficeView active={mode === 'office'} />
          </ErrorBoundary>
          {mode === 'office' && <EmptyState view="office" />}
        </div>
        {mode === 'canvas' && (
          <div className="stage__layer" data-active>
            <ErrorBoundary area="canvas">
              {/* No spinner: the board is a few hundred milliseconds away at
                  most, and a flash of one is worse than a beat of nothing. */}
              <Suspense fallback={null}>
                <CanvasView />
              </Suspense>
            </ErrorBoundary>
            <EmptyState view="canvas" />
          </div>
        )}
        {inspectorOpen && <Inspector />}
        {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
      </main>
    </div>
  );
}
