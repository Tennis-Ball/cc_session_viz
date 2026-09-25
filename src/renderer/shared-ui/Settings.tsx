import { useEffect } from 'react';
import { engineClient } from '../engine/client';
import { OFFICE_THEMES, dayFactorFor, resolveTheme } from '../office/theme/themes';
import { usePrefs } from '../store/prefs';
import { useWorld } from '../store/world';
import type { DataMode } from '@shared/model';
import type { MotionMode, OfficeDetail } from '@shared/prefs';
import './settings.css';

/**
 * Settings.
 *
 * A single sheet rather than a preferences window: everything here changes what
 * you are already looking at, so it belongs over the top of it, and every
 * control applies immediately — there is no Save button and nothing to confirm.
 */
export function Settings({ onClose }: { onClose: () => void }): React.JSX.Element {
  const prefs = usePrefs((s) => s.prefs);
  const update = usePrefs((s) => s.update);
  const simSeed = useWorld((s) => s.world.health.simSeed);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pinned = prefs.theme.pinnedClock;

  return (
    <div className="sheet-scrim" onMouseDown={onClose}>
      <section
        className="sheet"
        role="dialog"
        aria-label="Settings"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="sheet__head">
          <h2>Settings</h2>
          <button className="sheet__close" onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </header>

        <Group label="Office theme">
          <div className="theme-grid">
            {Object.values(OFFICE_THEMES).map(({ day }) => (
              <ThemeCard
                key={day.id}
                id={day.id}
                name={day.name}
                selected={prefs.theme.office === day.id}
                dayFactor={pinned ? dayFactorFor(clockOf(pinned)) : dayFactorFor(new Date())}
                onPick={() => update({ theme: { office: day.id } })}
              />
            ))}
          </div>
        </Group>

        <Group label="Lighting" hint="The office follows your clock unless you pin an hour.">
          <div className="row">
            <Toggle
              checked={pinned !== null}
              onChange={(on) => update({ theme: { pinnedClock: on ? '14:00' : null } })}
              label="Pin the time of day"
            />
            {pinned !== null && (
              <input
                className="time"
                type="time"
                value={pinned}
                onChange={(event) => update({ theme: { pinnedClock: event.target.value } })}
              />
            )}
          </div>
        </Group>

        <Group label="Motion" hint="Reduced swaps movement for fades and keeps the layout.">
          <Segmented
            value={prefs.motion}
            options={[
              ['auto', 'Follow system'],
              ['full', 'Full'],
              ['reduced', 'Reduced'],
            ]}
            onChange={(value) => update({ motion: value as MotionMode })}
          />
        </Group>

        <Group
          label="What to show"
          hint="The simulation is generated from nothing. It never contains, or borrows from, your own sessions."
        >
          <Segmented
            value={prefs.mode}
            options={[
              ['real', 'My sessions'],
              ['simulation', 'Simulation'],
            ]}
            onChange={(value) => {
              const mode = value as DataMode;
              update({ mode });
              engineClient.post({ type: 'setDataMode', mode });
            }}
          />
          {prefs.mode === 'simulation' && simSeed > 0 && (
            <p className="sheet__note">
              Seed <code>{simSeed}</code>. Every session, every fan-out and every quiet stretch follows from
              it — start the app with <code>CCV_SIM_SEED={simSeed}</code> to watch this one again.
            </p>
          )}
        </Group>

        <Group
          label="This world"
          hint="How the office itself is built: how its terraces step, and what it is made of. Kept between launches, so it stays your office."
        >
          <button className="sheet__action" onClick={() => update({ office: { worldSeed: rollSeed() } })}>
            Build a different world
          </button>
          <Segmented
            value={prefs.office.detail}
            options={[
              ['quiet', 'Quiet'],
              ['composed', 'Composed'],
              ['ornate', 'Ornate'],
            ]}
            onChange={(value) => update({ office: { detail: value as OfficeDetail } })}
          />
          <p className="sheet__note">
            How much the world builds on itself. Quiet is a few large gestures and a lot of sky; ornate
            builds everything it is allowed to. The seed is unchanged either way — it is the same place,
            more or less furnished.
          </p>
          <Toggle
            checked={prefs.office.npcs}
            onChange={(on) => update({ office: { npcs: on } })}
            label="Caretakers"
          />
          <p className="sheet__note">
            Caretakers are people who work here but are not your sessions; nothing they do means anything.
          </p>
        </Group>

        <Group label="Music" hint="Synthesised, not sampled. Fades out when the window is hidden.">
          <Toggle
            checked={prefs.sound.enabled}
            onChange={(on) => update({ sound: { enabled: on } })}
            label="Ambient music"
          />
          {prefs.sound.enabled && (
            <label className="slider">
              <span>Volume</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={prefs.sound.master}
                onChange={(event) => update({ sound: { master: Number(event.target.value) } })}
              />
            </label>
          )}
        </Group>

        <Group label="Sessions">
          <Toggle
            checked={prefs.hideSdkSessions}
            onChange={(on) => update({ hideSdkSessions: on })}
            label="Hide sessions started by the SDK"
          />
          <label className="slider">
            <span>Keep an ended desk for</span>
            <input
              type="range"
              min={0}
              max={30}
              step={1}
              value={Math.round(prefs.endedGraceMs / 60_000)}
              onChange={(event) => update({ endedGraceMs: Number(event.target.value) * 60_000 })}
            />
            <em>{Math.round(prefs.endedGraceMs / 60_000)} min</em>
          </label>
        </Group>

        <footer className="sheet__foot">Atrium never writes to ~/.claude. It only reads.</footer>
      </section>
    </div>
  );
}

/** A fresh world seed. Never zero, which is the "not rolled yet" value. */
function rollSeed(): number {
  return (Math.floor(Math.random() * 0xffffffff) || 1) >>> 0;
}

function Group({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="group">
      <h3>{label}</h3>
      {hint && <p className="hint">{hint}</p>}
      {children}
    </section>
  );
}

/**
 * A theme swatch made of the theme's own colours at the current hour.
 *
 * Cheaper and steadier than a second WebGL canvas per theme, and it shows the
 * thing that actually distinguishes them: the sky, and the three face tones the
 * whole office is built from.
 */
function ThemeCard({
  id,
  name,
  selected,
  dayFactor,
  onPick,
}: {
  id: string;
  name: string;
  selected: boolean;
  dayFactor: number;
  onPick: () => void;
}): React.JSX.Element {
  const theme = resolveTheme(id, dayFactor);
  return (
    <button className="theme-card" data-selected={selected} onClick={onPick}>
      <span
        className="theme-card__sky"
        style={{ background: `linear-gradient(${theme.sky[2]}, ${theme.sky[1]}, ${theme.sky[0]})` }}
      >
        <i style={{ background: theme.tones.top }} />
        <i style={{ background: theme.tones.left }} />
        <i style={{ background: theme.tones.right }} />
        <em style={{ background: theme.accent }} />
      </span>
      <span className="theme-card__name">{name}</span>
    </button>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}): React.JSX.Element {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="toggle__track" aria-hidden />
      <span>{label}</span>
    </label>
  );
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <div className="segmented segmented--sheet" role="tablist">
      {options.map(([id, label]) => (
        <button key={id} role="tab" data-active={value === id} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** "14:00" → a Date today at that hour, for the preview swatches. */
function clockOf(value: string): Date {
  const date = new Date();
  const [hours, minutes] = value.split(':');
  date.setHours(Number(hours ?? 12), Number(minutes ?? 0), 0, 0);
  return date;
}
