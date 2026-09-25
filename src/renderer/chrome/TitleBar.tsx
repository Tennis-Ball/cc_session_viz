import { useCallback, useEffect, useRef } from 'react';
import { engineClient } from '../engine/client';
import { usePrefs } from '../store/prefs';
import { useWorld } from '../store/world';
import { useUi, type ViewMode } from '../store/ui';
import type { DataMode } from '@shared/model';
import { SessionCounter } from './SessionCounter';

const MODES: { id: ViewMode; label: string }[] = [
  { id: 'office', label: 'Office' },
  { id: 'canvas', label: 'Canvas' },
];

export function TitleBar({ onOpenSettings }: { onOpenSettings: () => void }): React.JSX.Element {
  const mode = useUi((s) => s.mode);
  const setMode = useUi((s) => s.setMode);
  const toggleInspector = useUi((s) => s.toggleInspector);
  const inspectorOpen = useUi((s) => s.inspectorOpen);
  const health = useWorld((s) => s.world.health);
  const connected = useWorld((s) => s.connected);

  const dataMode = health.mode;
  const prefsMode = usePrefs((s) => s.prefs.mode);
  const prefsLoaded = usePrefs((s) => s.loaded);
  const updatePrefs = usePrefs((s) => s.update);

  const setDataMode = useCallback(
    (next: DataMode): void => {
      engineClient.post({ type: 'setDataMode', mode: next });
      updatePrefs({ mode: next });
    },
    [updatePrefs],
  );

  // Restore the remembered mode once, unless the environment pinned it — the
  // screenshot runs set CCV_MODE and must not be overruled by a prefs file.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !prefsLoaded || !connected || health.modeLocked) return;
    restored.current = true;
    if (prefsMode !== health.mode) engineClient.post({ type: 'setDataMode', mode: prefsMode });
  }, [prefsLoaded, connected, prefsMode, health.mode, health.modeLocked]);

  // ⌥S swaps between your sessions and the simulation.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.altKey || event.key.toLowerCase() !== 's') return;
      setDataMode(dataMode === 'real' ? 'simulation' : 'real');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dataMode, setDataMode]);

  return (
    <header className="titlebar">
      <div className="titlebar__left">
        <span className="wordmark">Atrium</span>
      </div>

      <div className="segmented" role="tablist" aria-label="View mode">
        {MODES.map((m) => (
          <button key={m.id} role="tab" data-active={mode === m.id} onClick={() => setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>

      <div className="titlebar__right">
        <button
          className={`chip ${dataMode === 'simulation' ? 'chip--simulation' : ''}`}
          title="Your sessions, or a generated office that contains none of them (⌥S)"
          onClick={() => setDataMode(dataMode === 'real' ? 'simulation' : 'real')}
        >
          {dataMode === 'simulation' ? 'Simulation' : 'Live'}
        </button>
        <SessionCounter />
        <button className="chip" onClick={toggleInspector} style={{ cursor: 'default' }}>
          {inspectorOpen ? 'Hide inspector' : 'Inspector'}
        </button>
        <button className="chip" onClick={onOpenSettings} title="Settings (⌘,)">
          Settings
        </button>
        {!connected && <span className="chip">connecting…</span>}
      </div>
    </header>
  );
}
