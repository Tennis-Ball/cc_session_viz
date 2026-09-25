# Atrium

A purely visual companion for Claude Code sessions. It watches `~/.claude`, never touches it, and draws what your sessions are doing two ways:

- **Office** — a Monument-Valley-ish isometric office. Every session gets a desk; agents walk to the Library to read, the Workshop to run commands, the Atelier to think, the Watchtower to watch background work, and the Lounge when there is nothing to do. A ring over someone's head means a session is waiting on you.
- **Canvas** — a black board of terminal cards, each showing a replica of the Claude Code TUI rebuilt from the transcript, with subagents hanging below their parent on copper edges.

There is also a **menu bar glance** (session list, context bars, what each one is doing) and a **usage panel** on the canvas, which reads your real limits from the token Claude Code already stores — read-only, never refreshed — and reads your account limits directly.

It never launches, controls or sends input to a session. cmux stays the place work actually happens.

## Running it

```sh
npm install
npm run dev        # electron-vite dev server
npm run build      # bundle main / preload / renderer into out/
npm test           # unit tests (vitest)
npm run typecheck  # three tsconfig projects: node, web, tests
npx playwright test  # launches the built app and captures artifacts/shots/
npm run dist       # a signed-ad-hoc Atrium.app and .dmg in dist/
node scripts/render-icon.ts       # regenerate resources/icon.icns
node scripts/render-tray-icon.ts  # regenerate the menu bar template images
```

`⌘1` / `⌘2` switch modes, `⌘,` opens Settings. In the office, drag to orbit, scroll to zoom, `[` / `]` swing 45°, `0` resets; hover a figure to see what it is doing, click one to jump to its terminal. `⌥S` swaps between your sessions and the simulation.

Settings (theme, pinned lighting, motion, music, what to show, session filters) and the camera angle, desk placements and window state live in a single prefs file under `userData`. **That file is the only thing this app writes anywhere.**

### Data sources

| `CCV_SOURCE` | what it reads |
|---|---|
| `live` (default) | the real `~/.claude` tree |
| `ambient` | nothing on disk — the generated office only |
| `sim` | the M0 placeholder source |

`CCV_MODE=real\|simulation` pins what the app shows. The two are exclusive: the simulation is generated from nothing and never contains, or borrows from, a real session.

## Layout

```
src/shared/     the contract: World, TranscriptEntry, VisualEvent, protocol, palette
src/main/       Electron main: windows, the menu bar tray, the engine utilityProcess, port broker
src/preload/    contextBridge: a MessagePort relay and nothing else
src/engine/     runs in a utilityProcess
  discovery/    the live registry and where a session's files are
  io/           incremental tailing of append-only JSONL
  parse/        normalize.ts is the ONLY module that knows Claude Code field names
  state/        reducers, liveness, transcript logs
  sources/      live, the simulation, mock
src/renderer/
  canvas/       React Flow board, terminal cards, the TUI replica
  office/       react-three-fiber scene: facet material, campus, figures
  tray/         the menu bar popover, the same bundle loaded at #tray
resources/      the menu bar template icon, rendered by scripts/render-tray-icon.ts
fixtures/       anonymized real sessions, used by the engine tests
scripts/        schema-drift.ts (read-only probe), record-fixture.ts, render-tray-icon.ts
```

## The two rules

1. **`normalize.ts` is the only place that knows the transcript format.** It changes between Claude Code point releases; everything downstream speaks `Signal`. `node scripts/schema-drift.ts` reports anything new.
2. **One material, one prop kit, one palette.** The office is unlit: faces take their tone from the direction they point. Every object goes through `office/props/kit.ts` so the whole place stays one picture.

The full design — art direction, the nuance matrix of every Claude Code behaviour and how it is drawn, and the milestone plan — lives in `~/.claude/plans/i-want-to-create-humble-stallman.md`.
