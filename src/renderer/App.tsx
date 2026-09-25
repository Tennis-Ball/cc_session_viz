import { useEffect, useState } from 'react';
import { CanvasView } from './canvas/CanvasView';
import { OfficeView } from './office/OfficeView';
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
  const motion = usePrefs((s) => s.prefs.motion);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useOfficeMusic();
  useEffect(() => engineClient.start(), []);
  useEffect(() => void hydrate(), [hydrate]);

  // Reduced motion is a document-level switch: CSS keys off it, and the office
  // reads the same attribute rather than threading a prop through the scene.
  useEffect(() => {
    const system = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = (): void => {
      const reduced = motion === 'reduced' || (motion === 'auto' && system.matches);
      document.documentElement.dataset['motion'] = reduced ? 'reduced' : 'full';
    };
    apply();
    system.addEventListener('change', apply);
    return () => system.removeEventListener('change', apply);
  }, [motion]);

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
        </div>
        {mode === 'canvas' && (
          <div className="stage__layer" data-active>
            <ErrorBoundary area="canvas">
              <CanvasView />
            </ErrorBoundary>
          </div>
        )}
        {inspectorOpen && <Inspector />}
        {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
      </main>
    </div>
  );
}
