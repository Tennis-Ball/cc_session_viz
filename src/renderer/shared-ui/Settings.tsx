import { useEffect } from 'react';
import { engineClient } from '../engine/client';
import { OFFICE_THEMES, dayFactorFor, resolveTheme } from '../office/theme/themes';
import { MOTIF_NAMES, worldVoice } from '../office/world/architecture';
import { usePrefs } from '../store/prefs';
import type { DataMode } from '@shared/model';
import type { Horizon, OfficeDetail, Weather } from '@shared/prefs';
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
  // Free: both answers come off the first two draws of the seed.
  const voice = worldVoice(prefs.office.worldSeed);

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
        </Group>

        <Group
          label="This world"
          hint="How the office itself is built: how its terraces step, and what it is made of. Kept between launches, so it stays your office."
        >
          <p className="sheet__note">
            This one is fond of <strong>{MOTIF_NAMES[voice.favoured[0]!]}</strong>, then{' '}
            {MOTIF_NAMES[voice.favoured[1]!]} and {MOTIF_NAMES[voice.favoured[2]!]} — but it can build anything
            in the bank, and every world gets a waterfall and a drape canopy.
          </p>
          <button className="sheet__action" onClick={() => update({ office: { worldSeed: rollSeed() } })}>
            Build a different world
          </button>
          {/*
            * Naming it is most of what makes the button above worth pressing.
            *
            * A world draws its favourites out of the whole bank on first launch
            * and then keeps them for ever — which is right, and which also
            * means somebody who has had this open for a month has seen a
            * fraction of what it can build and no way of knowing that. "Build a
            * different world" said nothing about what would be different.
            * Saying what this one is fond of turns a mystery button into an
            * offer.
            */}
          <Segmented
            value={prefs.office.detail}
            options={[
              ['quiet', 'Quiet'],
              ['ornate', 'Ornate'],
            ]}
            onChange={(value) => update({ office: { detail: value as OfficeDetail } })}
          />
          <p className="sheet__note">
            How much the world builds on itself. Quiet is a few large gestures and a lot of sky; ornate
            builds everything it is allowed to. The seed is unchanged either way — it is the same place,
            more or less furnished.
          </p>
          <Segmented
            value={prefs.office.weather}
            options={[
              ['clear', 'Clear'],
              ['cloudy', 'Cloudy'],
              ['rain', 'Rain'],
            ]}
            onChange={(value) => update({ office: { weather: value as Weather } })}
          />
          <Segmented
            value={prefs.office.horizon}
            options={[
              ['none', 'Empty sky'],
              ['isles', 'Isles'],
            ]}
            onChange={(value) => update({ office: { horizon: value as Horizon } })}
          />
          <p className="sheet__note">
            What is out there past the office: small terraces on their own rock, cut from the same stone as
            the campus and turning with it. The void has no distance in it — every platform is equally far
            away because there is nothing behind them to be further than — so these say it by being small,
            low and nearly the colour of the sky.
          </p>
          <Toggle
            checked={prefs.office.labels}
            onChange={(on) => update({ office: { labels: on } })}
            label="Room and desk names"
          />
          <p className="sheet__note">
            The only text in the world. Off, the office is a place rather than a plan — you can still find a
            session by pointing at a figure, and the colours on the desks are the same ones the canvas uses.
          </p>
          <Toggle
            checked={prefs.office.npcs}
            onChange={(on) => update({ office: { npcs: on } })}
            label="Other people"
          />
          <p className="sheet__note">
            People who work here but are not your sessions. They sit, read, fetch a drink and shoo the birds
            off the towers; nothing any of it means anything.
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
