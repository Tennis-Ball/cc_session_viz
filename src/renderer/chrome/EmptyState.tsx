import { useWorld } from '../store/world';
import { engineClient } from '../engine/client';
import './empty.css';

/**
 * What the app says when there is nothing to show.
 *
 * Both views had no answer to this at all. The canvas was a black rectangle
 * with a dot grid on it and the office was a beautiful silent city, and neither
 * said what was missing or what to do about it — which is exactly what someone
 * sees the first time they open a freshly downloaded copy, because the ordinary
 * case is that Claude Code is not running at that moment. A blank screen reads
 * as a broken app, and a first impression is not a state you get to design
 * later.
 *
 * Deliberately one sentence and two buttons. The office is the picture; this is
 * a caption on it, not a dialog in front of it.
 */
export function EmptyState({ view }: { view: 'office' | 'canvas' }): React.JSX.Element | null {
  const sessions = useWorld((s) => s.world.sessions);
  const health = useWorld((s) => s.world.health);
  const connected = useWorld((s) => s.connected);

  if (Object.keys(sessions).length > 0) return null;

  // Three different nothings, and they want three different sentences: the
  // engine has not answered yet, the simulation is warming up, or Claude Code
  // genuinely is not running. Telling someone to start a session while the app
  // is still connecting would be wrong about half the time.
  const state = !connected ? 'connecting' : health.mode === 'simulation' ? 'warming' : 'idle';

  return (
    <div className="empty" data-view={view}>
      <div className="empty__card">
        {state === 'connecting' && <p className="empty__line">Connecting…</p>}

        {state === 'warming' && <p className="empty__line">Building a generated office…</p>}

        {state === 'idle' && (
          <>
            <p className="empty__line">No Claude Code sessions are running.</p>
            <p className="empty__hint">
              {view === 'office'
                ? 'Start one in a terminal and a desk appears here.'
                : 'Start one in a terminal and a card appears here.'}
            </p>
            <div className="empty__actions">
              <button
                type="button"
                className="empty__button"
                onClick={() => engineClient.post({ type: 'setDataMode', mode: 'simulation' })}
              >
                Watch the simulation
              </button>
              <span className="empty__key">⌥S</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
