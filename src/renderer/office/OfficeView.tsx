import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Vector3 } from 'three';
import { ACTIVITY_ZONE, type SlotKind, type ZoneId } from '@shared/activity';
import { paletteAt } from '@shared/palette';
import { HORIZONS, WEATHERS, type Horizon, type Weather } from '@shared/prefs';
import type { AgentView, Endpoint, SessionView, World } from '@shared/model';
import { engineClient } from '../engine/client';
import { usePrefs } from '../store/prefs';
import { useUi } from '../store/ui';
import { useWorld } from '../store/world';
import { attachFlickerProbe } from './dev/flickerProbe';
import { recordDomChurn } from './dev/domChurn';
import { applyVisualEvent, type Stage } from './anim/choreographer';
import { advanceOfficeClock, officeNow } from './anim/officeClock';
import { FigureController, separateFigures, setGroundLift, type ZoneResolver } from './anim/figureController';
import { FlightPool } from './anim/flights';
import { Staging } from './anim/staging';
import { NpcPopulation, npcCountFor } from './anim/npcs';
import { Conversations, gap, REACH, type Talker } from './anim/conversation';
import { IsoCamera } from './camera/IsoCamera';
import { applyTheme, setSunOffset, setVoidPlane } from './material/facet';
import { depthTint, scaleForTier } from './figures/geometry';
import { buildPropFor, propPalette } from './props/registry';
import { Envelopes } from './scene/Envelopes';
import { Figures, type FigureInstance } from './scene/Figures';
import { Labels } from './scene/Labels';
import { DeskPiles, ZoneWarmth } from './scene/Markers';
import { FigureCard } from './FigureCard';
import { Platforms } from './scene/Platforms';
import { Sky } from './scene/Sky';
import { Atmosphere } from './scene/Atmosphere';
import { Distance } from './scene/Distance';
import { Birds } from './scene/Birds';
import { dayFactorFor, isFalling, luma, mixHex, resolveTheme, sunOffsetFor, type ResolvedTheme } from './theme/themes';
import { buildCampus, type Campus, type DeskRequest } from './world/layout';
import { archBlockers, lowestFloor, planArchitecture, type ArchPlan } from './world/architecture';
import { NavGraph, type Vec3 } from './world/navGraph';
import { buildOccupancy, type Occupancy } from './world/occupancy';
import { boxCorners, type Point } from './camera/fit';
import { SlotPool } from './world/slots';
import { levelY } from './world/campusTemplate';
import './office.css';

/**
 * Office mode.
 *
 * Sessions own desks; agents walk to whichever shared zone matches what they
 * are doing. Everything here is derived from the same World the canvas uses, so
 * the two modes can never disagree about what is happening.
 */
export function OfficeView({ active = true }: { active?: boolean }): React.JSX.Element {
  /*
   * Whether the office is worth drawing at all: in front, and in a window that
   * is on screen. Pacing alone does not settle this. R3F invalidates after any
   * change to the scene graph, and the world arrives from the engine several
   * times a second whether or not anyone is looking, so a hidden office went on
   * quietly redrawing itself at the patch rate. `frameloop="never"` is the one
   * switch R3F's own `invalidate` checks before doing anything, so it is the
   * only way to say no and have it stick.
   */
  const [onScreen, setOnScreen] = useState(() => !document.hidden);
  useEffect(() => {
    const sync = (): void => setOnScreen(!document.hidden);
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);
  const drawing = active && onScreen;
  const world = useWorld((s) => s.world);
  // Who the card is about. Hovering is transient; clicking pins it, so you can
  // read the card without having to keep the pointer on a figure that walks
  // away while you are reading it.
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const subject = pinned ?? hovered;
  const select = useUi((s) => s.select);
  const setMode = useUi((s) => s.setMode);
  const openInCanvas = useCallback(
    (agentId: string) => {
      select(agentId);
      setMode('canvas');
    },
    [select, setMode],
  );
  const storedTheme = usePrefs((s) => s.prefs.theme.office);
  // `?theme=` alongside `?clock=`, `?seed=` and `?weather=`, for the same
  // reason: a screenshot of Ink & Paper at dusk has to be reproducible without
  // clicking through Settings, which means taking the front of the screen.
  const themeId = new URLSearchParams(window.location.search).get('theme') ?? storedTheme;
  const pinnedClock = usePrefs((s) => s.prefs.theme.pinnedClock);
  const weather = useWeather();
  const horizon = useHorizon();
  const [theme, setTheme] = useState<ResolvedTheme>(() =>
    resolveTheme(themeId, dayFactorFor(new Date()), isFalling(new Date())),
  );

  // The clock moves the palette, once a second, never per frame.
  useEffect(() => {
    const update = (): void => {
      const at = officeClock(pinnedClock);
      setTheme(resolveTheme(themeId, dayFactorFor(at), isFalling(at)));
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [themeId, pinnedClock]);

  useEffect(() => {
    applyTheme(theme);
    // The sun rides the clock while the basis rides the camera. Without this
    // the office is lit identically at six in the morning and eight at night.
    setSunOffset(sunOffsetFor(theme.dayFactor, theme.falling));
  }, [theme]);

  /**
   * The labels are HTML over a canvas whose palette runs from cream to indigo,
   * so their ink has to move with it. Written as CSS variables rather than
   * inline styles because the labels are drawn by drei's `Html` portals, which
   * are not children of anything this component renders.
   */
  useEffect(() => {
    const root = document.documentElement.style;
    /*
     * Chosen against what is actually behind the letters, not against the hour.
     *
     * This used to flip on `dayFactor < 0.5`, which had two faults at once. It
     * was a hard switch, so every label in the office changed colour in one
     * frame somewhere around half past seven. And it was the wrong question:
     * the labels sit on platform tops, and a platform top is pale in every
     * theme at every hour — it is the *sky* that goes dark. So the office spent
     * the whole of dawn putting pale letters on pale stone, and the zone names
     * disappeared exactly when the campus needed them most.
     *
     * Asking the surface how bright it is gives a continuous answer and cannot
     * drift out of step with a palette someone edits later. The same trick is
     * what keeps Ink & Paper's clouds off its paper; see `atmosphereTones`.
     */
    const floor = theme.platform.top;
    const dark = luma(floor) > 0.5;
    const ink = dark ? mixHex(floor, '#000000', 0.82) : mixHex(floor, '#FFFFFF', 0.86);
    const halo = dark ? mixHex(floor, '#FFFFFF', 0.55) : mixHex(floor, '#000000', 0.62);
    root.setProperty('--office-ink', withAlpha(ink, 0.72));
    root.setProperty('--office-ink-strong', withAlpha(ink, 0.92));
    root.setProperty('--office-ink-halo', withAlpha(halo, 0.8));
    /*
     * The rim the glyphs are cut out of.
     *
     * A soft glow separates letters from a *plain* background and does nothing
     * at all against the office, where a name can straddle a pale deck, a dark
     * rock face and open sky inside one word. Nearly opaque, because the job is
     * to put a known colour behind every stroke rather than to suggest one.
     */
    root.setProperty('--office-ink-rim', withAlpha(halo, 0.94));
  }, [theme]);

  // WebGL contexts are lost on sleep/wake, on a GPU driver reset, and when the
  // system decides an app has too many. The browser will not restore one on its
  // own here, so the scene is rebuilt from scratch — which is cheap, because
  // every bit of geometry is generated.
  const [generation, setGeneration] = useState(0);
  const [lost, setLost] = useState(false);
  const rebuild = useCallback(() => {
    setLost(false);
    setGeneration((n) => n + 1);
  }, []);

  const onCreated = useCallback(
    ({ gl }: { gl: { domElement: HTMLCanvasElement } }) => {
      const element = gl.domElement;
      const onLost = (event: Event): void => {
        // Without preventDefault the context can never come back at all.
        event.preventDefault();
        setLost(true);
      };
      const onRestored = (): void => rebuild();
      element.addEventListener('webglcontextlost', onLost);
      element.addEventListener('webglcontextrestored', onRestored);
    },
    [rebuild],
  );

  // Keyed on *content*, not on the sessions object: the engine hands the
  // renderer a fresh sessions map ten times a second, and rebuilding the floor
  // plan that often re-homes every figure mid-stride — they restart their walk
  // forever and never arrive anywhere.
  const deskKey = deskSignature(world);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const desks = useMemo(() => deskRequests(world), [deskKey]);

  const savedCells = usePrefs((s) => s.prefs.office.deskCells);
  const savedSeed = usePrefs((s) => s.prefs.office.worldSeed);
  const savePrefs = usePrefs((s) => s.update);
  hydrateDeskCells(savedCells);

  const detail = usePrefs((s) => s.prefs.office.detail);
  const labelsOn = usePrefs((s) => s.prefs.office.labels);

  /*
   * Rooms arriving and leaving, shared by everything that draws one.
   *
   * It lives here rather than inside `Platforms` because a desk is not only a
   * platform: it is also a mast, a nameplate and a pool of lamplight, each
   * drawn by a different component. They all have to come up together or the
   * flag arrives before the building it flies from.
   */
  const staging = useMemo(() => new Staging(), []);
  /*
   * What the caretaker you are pointing at is up to.
   *
   * A ref rather than state: it is read while the card renders and it must not
   * cause a render of its own — the office redraws sixty times a second and
   * re-rendering React for a caption would undo the whole reason the figures
   * are written straight into instance matrices.
   */
  const npcNote = useRef<(id: string) => string | null>(() => null);
  /**
   * Who this figure has stopped to talk to, in words, or null.
   *
   * Filled in from inside the canvas, where the conversations are, and read by
   * the card outside it. A ref rather than state because it changes whenever
   * anybody starts or stops talking, which is several times a minute, and the
   * card is the only thing that ever asks.
   */
  const chatNote = useRef<(id: string) => string | null>(() => null);
  // Everybody standing on a room that is still coming up rides it up.
  useEffect(() => setGroundLift((id) => (id ? staging.offsetOf(id) : 0)), [staging]);

  const seed = worldSeed(savedSeed);
  const campus = useMemo(() => {
    REBUILDS.campus += 1;
    return buildCampus(desks, deskCells, seed, detail);
  }, [desks, seed, detail]);

  // How this world is terraced and what it is built out of: one seed, so the
  // architecture and the skyline belong to each other. The detail setting says
  // how much of it gets built; the seed still decides what and where, so
  // turning the office down does not turn it into a different place.
  const architecture = useMemo(() => {
    REBUILDS.architecture += 1;
    return planArchitecture(campus, seed, detail);
  }, [campus, seed, detail]);
  // The fade starts just under the lowest terrace and has finished long before
  // the rock does, so a hillside world stands on something that has no bottom.
  useEffect(() => setVoidPlane(lowestFloor(campus) - 5.5, 7.5), [campus]);


  // Remember the placements and the seed the office just invented.
  useEffect(() => {
    const cells: Record<string, [number, number]> = {};
    for (const [id, cell] of deskCells) cells[id] = cell;
    const office: { deskCells?: typeof cells; worldSeed?: number } = {};
    if (Object.keys(cells).length) office.deskCells = cells;
    if (savedSeed !== seed) office.worldSeed = seed;
    if (Object.keys(office).length) savePrefs({ office });
  }, [campus, savedSeed, seed, savePrefs]);
  // What has to stay in frame: each platform, plus headroom for the props on
  // it and the label that sits just off its edge. Fitting to the platforms
  // rather than one box around everything matters — a box around a ring of
  // terraces is mostly empty air.
  /*
   * Double-clicking a desk frames it, and `0` or Escape gives the campus back.
   *
   * The office was only ever watchable: you could orbit it and you could pin a
   * card, but there was no way to *go and look at* one session — and once there
   * are a dozen desks, wanting to look at one of them is the ordinary reason to
   * open the app. Framing is the gesture that turns the picture into a tool,
   * and it costs nothing: the camera already fits itself to a set of points, so
   * focusing is handing it a smaller set.
   */
  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => {
    if (focus && !campus.platforms.some((platform) => platform.id === focus)) setFocus(null);
  }, [campus, focus]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey) return;
      if (event.key === 'Escape' || event.key === '0') setFocus(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /**
   * Half the campus footprint, for the scenery to stand outside of.
   *
   * Taken off every platform rather than off the framed subset: focusing on one
   * room must not bring the whole distance in around it.
   */
  const horizonFrom = useMemo((): { centre: [number, number]; spread: number } => {
    /*
     * Where the campus is and how big it is — both measured, neither assumed.
     *
     * This used to return one number: the furthest platform edge *from the
     * origin*. The campus template does not centre the campus on the origin,
     * so that number was the distance from a corner, and the ring of landmarks
     * drawn at that radius about the origin fell almost entirely outside the
     * window. `bounds` has said where the campus actually is all along.
     */
    const { min, max } = campus.bounds;
    return {
      centre: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2],
      spread: Math.max(max[0] - min[0], max[1] - min[1]) / 2,
    };
  }, [campus]);

  const frame = useMemo<Point[]>(() => {
    const points: Point[] = [];
    const framed = focus ? campus.platforms.filter((platform) => platform.id === focus) : campus.platforms;
    for (const platform of framed) {
      const y = levelY(platform.level);
      // A tower or a canopy stands well above the props, and cropping the top
      // off the one thing that gives the campus a skyline defeats the point of
      // building it. The horizon slabs are deliberately left out: they are
      // scenery, and framing them would push the office into the distance.
      const built = architecture.onPlatform.get(platform.id) ?? [];
      const headroom = built.reduce(
        (top, p) => Math.max(top, p.at[1] + (p.shape === 'box' ? p.size[1] : p.shape === 'column' ? p.height : p.radius)),
        2.6,
      );
      points.push(
        ...boxCorners(
          [platform.position[0] - platform.size[0] / 2 - 1, y - 1.2, platform.position[1] - platform.size[1] / 2 - 1],
          [
            platform.position[0] + platform.size[0] / 2 + 1,
            y + headroom + 0.4,
            platform.position[1] + platform.size[1] / 2 + 1.4,
          ],
        ),
      );
    }
    return points;
  }, [campus, architecture, focus]);

  return (
    <div className="office-view">
      <Canvas
        key={generation}
        orthographic
        dpr={[1, 2]}
        /*
         * A campus spans tens of units, so a 1200-unit depth range spends most
         * of its precision on empty space either side of the office. Anything
         * drawn flush with a floor — a walkway deck meeting the terrace it
         * lands on, a paving slab, a contact shadow — then sits inside the same
         * depth bucket as the floor, and which one wins is decided per pixel
         * and changes as you orbit. That is the "platforms at the same level as
         * the floor glitch out" report. Enough room for the rock below and the
         * horizon slabs behind, and nothing like 1200.
         */
        camera={{ position: [40, 40, 40], zoom: 26, near: -120, far: 260 }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        /*
         * Explicitly `demand`, driven by the ticker below.
         *
         * This was simply absent, so it defaulted to `always` and the office
         * redrew on every vsync for the life of the window — 120 fps on a
         * ProMotion display, for a picture that measures 887 changed pixels out
         * of 4.9 million and is byte-identical on one frame in twenty. An
         * ambient thing you leave open all day has no business holding the GPU
         * at full rate to redraw the same frame.
         */
        frameloop={drawing ? 'demand' : 'never'}
        onCreated={onCreated}
      >
        <Ticker active={drawing} />
        {/*
          * The sky flattens a little under cloud; the *clouds* do the rest.
          *
          * This used to be 0.7 and 1.0, which desaturated the whole gradient
          * and put the sun out — and since the cloud layer was dissolving
          * itself at the time, that wash was the entire visible difference
          * between clear and overcast. It was the haze.
          *
          * And a cloudy day gets none of it now. Flattening the sky is what
          * happens under a lid; a sky full of bright cumulus is still a sunny
          * sky, and taking the sun out of it was most of why cloudy looked
          * like a worse version of clear rather than a different day.
          */}
        <Sky theme={theme} overcast={weather === 'rain' ? 0.5 : 0} />
        <Atmosphere theme={theme} seed={seed} weather={weather} />
        {/*
          * The distance, in front of the sky and behind the office.
          *
          * Geometry, not a painted layer — see `scenery.ts`. It stands well
          * out past the campus and is deliberately absent from the camera's
          * fitting frame above, so however far it sprawls the office keeps the
          * size it had.
          */}
        <Distance
          theme={theme}
          seed={seed}
          kind={horizon}
          floorY={lowestFloor(campus)}
          centre={horizonFrom.centre}
          spread={horizonFrom.spread}
        />
        <Platforms
          campus={campus}
          theme={theme}
          architecture={architecture}
          staging={staging}
          onPick={(point) => setFocus((current) => (current ? null : nearestPlatform(campus, point)))}
        />
        <ZoneWarmth campus={campus} world={world} accent={theme.accent} />
        <DeskPiles campus={campus} world={world} staging={staging} accent={theme.accent} />
        {labelsOn && <Labels campus={campus} world={world} staging={staging} />}
        <Population
          world={world}
          campus={campus}
          npcNote={npcNote}
          chatNote={chatNote}
          theme={theme}
          architecture={architecture}
          seed={seed}
          subject={subject}
          onHover={setHovered}
          onPin={setPinned}
        />
        <IsoCamera frame={frame} />
      </Canvas>
      {subject && (
        <FigureCard
          {...(world.agents[subject] ? { agent: world.agents[subject] } : {})}
          {...(world.agents[subject] && world.sessions[world.agents[subject]!.slotId]
            ? { session: world.sessions[world.agents[subject]!.slotId] }
            : {})}
          npc={!world.agents[subject]}
          {...(world.agents[subject] ? {} : { doing: npcNote.current(subject) ?? undefined })}
          {...(chatNote.current(subject) ? { talkingTo: chatNote.current(subject)! } : {})}
          pinned={pinned === subject}
          onOpen={() => openInCanvas(subject)}
          onClose={() => {
            setPinned(null);
            setHovered(null);
          }}
        />
      )}
      {lost && (
        <div className="office-lost">
          <div>
            <p>The office lost its graphics context.</p>
            <button onClick={rebuild}>Draw it again</button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Screenshot runs and the pinned-time setting need a fixed hour; everything else
 * follows the real clock. The query string wins, so a screenshot is reproducible
 * whatever the prefs file says.
 */
function officeClock(pinnedPref: string | null): Date {
  const pinned = new URLSearchParams(window.location.search).get('clock') ?? pinnedPref;
  if (pinned) {
    const date = new Date();
    const [hours, minutes] = pinned.split(':');
    date.setHours(Number(hours ?? 12), Number(minutes ?? 0), 0, 0);
    return date;
  }
  return new Date();
}

/**
 * Desk assignments, kept outside React so the floor plan is stable for the life
 * of the app, and mirrored into prefs so it survives a restart: coming back to
 * find your session has moved across the office is disorienting.
 */
const deskCells = new Map<string, [number, number]>();

/**
 * The world's seed, settled once per run.
 *
 * Rolled on first launch and then kept in prefs: a world that reshuffles its
 * terraces and rebuilds its architecture on every start is a different place
 * every time you open it, and none of them is yours. `?seed=` overrides it so a
 * screenshot is reproducible, and so you can go looking at other worlds.
 */
let rolledSeed = 0;

function worldSeed(saved: number): number {
  const asked = new URLSearchParams(window.location.search).get('seed');
  if (asked) return Number(asked) >>> 0;
  if (saved) return saved;
  // A run must not re-roll mid-render: every roll rebuilds the whole campus.
  if (!rolledSeed) rolledSeed = (Math.floor(Math.random() * 0xffffffff) || 1) >>> 0;
  return rolledSeed;
}

/**
 * The weather, with `?weather=` able to override it.
 *
 * The same affordance `clock` and `seed` already have, and for the same reason:
 * a screenshot of a rainstorm has to be reproducible, and the alternative is a
 * test that clicks through Settings — which means taking the keyboard and the
 * front of the screen, the two things these runs must never do.
 */
function useWeather(): Weather {
  const stored = usePrefs((s) => s.prefs.office.weather);
  const asked = new URLSearchParams(window.location.search).get('weather');
  return WEATHERS.includes(asked as Weather) ? (asked as Weather) : stored;
}

/** `?horizon=` alongside the rest; see `useWeather`. */
function useHorizon(): Horizon {
  const stored = usePrefs((s) => s.prefs.office.horizon);
  const asked = new URLSearchParams(window.location.search).get('horizon');
  return HORIZONS.includes(asked as Horizon) ? (asked as Horizon) : stored;
}

function hydrateDeskCells(saved: Record<string, [number, number]>): void {
  for (const [id, cell] of Object.entries(saved)) {
    if (!deskCells.has(id)) deskCells.set(id, cell);
  }
}

/**
 * Session titles are sentences ("Run olympix toolsuite on Eigen.sol contract").
 * A nameplate is not a place for a sentence: it runs across the office and over
 * everything else. Cut it at a word boundary.
 */
function shortLabel(title: string): string {
  const limit = 26;
  if (title.length <= limit) return title;
  const cut = title.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return `${(space > 12 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Everything about the world that changes the floor plan, and nothing else.
 *
 * Emphatically not the title. A session is renamed several times in its first
 * minute — the registry name, then the agent name, then the model's own
 * summary — and every rename used to rebuild the campus: new platforms, a
 * replanned building, a fresh merge of every piece of geometry, and a camera
 * that refits and slides to a new framing. That is the office visibly
 * regenerating itself at random while you are looking at it. Nameplates read
 * the live title directly instead, so a rename is a rename.
 */
/**
 * Which desk a click landed on or nearest to.
 *
 * Nearest rather than strictly inside, because the thing someone is aiming at
 * is small: a click that lands an inch off a pod's edge on the walkway plainly
 * means that desk.
 *
 * Every platform, not only the desks. Framing was written for the pods, on the
 * reasoning that zooming to the Library would be zooming to scenery — which
 * was true when a zone was a floor with two props on it, and stopped being
 * true when zones started carrying the architecture. Half of what there is to
 * look at in this office is on a room you could not get close to, and a
 * double-click that does nothing on four fifths of the campus reads as a
 * broken control rather than a deliberate one.
 *
 * The radius scales with the platform, because a zone is three times the size
 * of a pod and a fixed six units is generous on one and miserly on the other.
 */
function nearestPlatform(campus: Campus, point: [number, number, number]): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  for (const platform of campus.platforms) {
    const dx = point[0] - platform.position[0];
    const dz = point[2] - platform.position[1];
    // Distance outside the footprint, so a big room does not win a click that
    // landed on the small one standing next to it.
    const outside = Math.hypot(
      Math.max(0, Math.abs(dx) - platform.size[0] / 2),
      Math.max(0, Math.abs(dz) - platform.size[1] / 2),
    );
    if (outside < bestScore) {
      bestScore = outside;
      best = platform.id;
    }
  }
  // Well outside whatever was hit, and well short of the next room along.
  return bestScore <= 3.5 ? best : null;
}

/** Counted for the probe: see `rebuilds` there for why. */
export const REBUILDS = { campus: 0, architecture: 0, geometry: 0 };

function deskSignature(world: World): string {
  return Object.values(world.sessions)
    .map((session) => `${session.id}:${session.colorIndex}`)
    .sort()
    .join('|');
}

function deskRequests(world: World): DeskRequest[] {
  return Object.values(world.sessions)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((session) => ({
      id: session.id,
      label: shortLabel(session.title),
      // Kept only as the first thing shown; `Labels` reads the live title.
      colorIndex: session.colorIndex,
      seats: 1,
    }));
}

/**
 * Keeps one controller per agent alive across frames, and feeds it activity.
 */
function Population({
  world,
  campus,
  theme,
  architecture,
  seed,
  subject,
  npcNote,
  chatNote,
  onHover,
  onPin,
}: {
  world: World;
  campus: Campus;
  theme: ResolvedTheme;
  architecture: ArchPlan;
  seed: number;
  subject: string | null;
  /** Filled in here, read by the card outside the canvas. */
  npcNote: MutableRefObject<(id: string) => string | null>;
  chatNote: MutableRefObject<(id: string) => string | null>;
  onHover: (id: string | null) => void;
  onPin: (id: string | null) => void;
}): React.JSX.Element {
  const controllers = useRef(new Map<string, FigureController>());
  const npcsOn = usePrefs((s) => s.prefs.office.npcs);
  const raining = useWeather() === 'rain';
  const [, force] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const gl = useThree((s) => s.gl);

  // Clicking somebody used to throw you straight into the canvas, which is a
  // lot to happen on one click in a scene you are mostly watching. Now it pins
  // the card, and the card offers the terminal.
  const interaction = useMemo(
    () => ({
      onHover,
      onSelect: (agentId: string) => onPin(agentId),
    }),
    [onHover, onPin],
  );

  // The resolver is rebuilt only when the floor plan changes, never when the
  // world ticks — a new resolver means every figure re-homes.
  const worldRef = useRef(world);
  worldRef.current = world;

  // Built together because they come from the same source: each platform's prop
  // supplies both the anchor points people stand on and the shape they have to
  // walk around.
  const { nav, slots } = useMemo(() => {
    const anchors = new Map<string, { kind: SlotKind; position: [number, number, number]; facing: number }[]>();
    const grids = new Map<string, Occupancy>();

    // Where each walkway meets each platform: those spots stay walkable.
    const doorways = new Map<string, [number, number][]>();
    for (const connector of campus.connectors) {
      doorways.set(connector.from, [...(doorways.get(connector.from) ?? []), [connector.a[0], connector.a[2]]]);
      doorways.set(connector.to, [...(doorways.get(connector.to) ?? []), [connector.b[0], connector.b[2]]]);
    }

    // Deliberately built as if every room were already furnished, even the
    // ones that have not gone up yet. A figure walks to a room *because* it
    // needs it, and the room goes up at that same moment, so it arrives to a
    // finished one; rebuilding the grid on every construction would instead
    // re-home the whole population and restart every walk in progress.
    for (const platform of campus.platforms) {
      const prop = buildPropFor(platform, propPalette(theme, platform));
      if (prop) anchors.set(platform.id, prop.slots);
      grids.set(
        platform.id,
        buildOccupancy(
          platform,
          prop?.geometry ?? null,
          doorways.get(platform.id) ?? [],
          archBlockers(architecture.onPlatform.get(platform.id) ?? []),
        ),
      );
    }

    const graph = new NavGraph(campus, grids);
    return { nav: graph, slots: new SlotPool(campus, anchors, grids) };
    // Slots are geometry, not colour: a theme change must not reseat anybody.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campus, architecture]);

  const resolver = useMemo<ZoneResolver>(
    () => ({
      platformFor(zone: ZoneId, agentId: string) {
        // "desk" means the agent's own session desk, everything else is shared.
        if (zone === 'desk') {
          const world = worldRef.current;
          const agent = world.agents[agentId];
          const session = agent ? world.sessions[agent.slotId] : undefined;
          const ownerId = session?.id;
          const platform = campus.platforms.find((p) => p.id === `desk:${ownerId}`);
          if (!platform) return null;
          return { platformId: platform.id, position: platformCentre(platform.position, platform.level) };
        }
        const platform = campus.platforms.find((p) => p.id === `zone:${zone}`);
        if (!platform) return null;
        return { platformId: platform.id, position: platformCentre(platform.position, platform.level) };
      },
      claimSlot(agentId, platformId, kind, near) {
        const claim = slots.claim(agentId, platformId, kind, near);
        return {
          position: claim.position,
          facing: claim.facing,
          ...(claim.seat === undefined ? {} : { seat: claim.seat }),
        };
      },
      platformAt(position) {
        const standing = campus.platforms.find(
          (p) =>
            Math.abs(position[0] - p.position[0]) <= p.size[0] / 2 &&
            Math.abs(position[2] - p.position[1]) <= p.size[1] / 2 &&
            Math.abs(position[1] - levelY(p.level)) < 1.2,
        );
        // Mid-walkway: nothing contains the figure, so start from whichever
        // platform it is closest to.
        return standing?.id ?? nav.nearestPlatform(position);
      },
      route(fromPlatform, from, toPlatform, to) {
        const origin = nav.has(fromPlatform) ? fromPlatform : (nav.nearestPlatform(from) ?? toPlatform);
        return nav.path(origin, from, toPlatform, to);
      },
    }),
    [campus, nav, slots],
  );

  // Events are transient and never touch React state: the choreographer writes
  // straight into the controllers that the frame loop is already reading.
  const flights = useMemo(() => new FlightPool(), []);
  const stage = useMemo<Stage>(
    () => ({
      controllers: controllers.current,
      world: () => worldRef.current,
      flights,
      zonePosition: (zone) => {
        const platform = campus.platforms.find((p) => p.id === `zone:${zone}`);
        return platform ? platformCentre(platform.position, platform.level) : null;
      },
    }),
    [campus, flights],
  );

  /**
   * Pairs the world has just said something passed between, on their way to
   * meeting about it. See `Conversations.summon`.
   *
   * A message is an event, and a conversation is a state that takes seconds to
   * set up — one of them has to walk over. This is the gap between the two: a
   * handful of pairs with a deadline, checked once a frame, cleared when they
   * are standing together and talking or when they have had long enough.
   */
  const meetings = useRef(new Map<string, Meeting>());

  useEffect(
    () =>
      engineClient.onVisualEvent((event) => {
        const now = officeNow();
        applyVisualEvent(event, stage, now);
        if (event.t !== 'message') return;
        const a = figureFor(event.link.from, worldRef.current, controllers.current);
        const b = figureFor(event.link.to, worldRef.current, controllers.current);
        // Both ends have to be somebody in the room. A message from a session
        // that has ended, or to one you are not running, is post — the envelope
        // already says that, and nobody can hold a conversation with it.
        if (!a || !b || a === b) return;
        /*
         * Whoever sent it is the host and stays put; the other one walks over.
         *
         * Somebody has to be still or the two of them spend the exchange
         * swapping places, and the sender is the one that is already where the
         * thing happened — at the mailroom counter, for a message to another
         * session, which is exactly where two of them meeting ought to be.
         */
        meetings.current.set(a < b ? `${a}|${b}` : `${b}|${a}`, { host: a, guest: b, by: now + MEET_TIMEOUT_MS, sent: false });
      }),
    [stage],
  );

  // The rest of the office. Seeded off the world, so it is always staffed the
  // same way, and rebuilt with the campus like everyone else.
  const npcs = useMemo(
    () => new NpcPopulation(seed, npcsOn ? npcCountFor(campus.platforms.length) : 0),
    [seed, npcsOn, campus.platforms.length],
  );

  /*
   * Who is standing about talking to whom.
   *
   * Seeded off the world like everything else, and cleared with the campus:
   * a conversation is about two particular people standing in one particular
   * place, and neither survives the floor plan being rebuilt underneath them.
   */
  const chatter = useMemo(() => new Conversations(seed), [seed]);
  useEffect(() => () => chatter.clear(), [chatter, campus]);

  // A read-only probe for the e2e run, which asserts that nobody is standing
  // in mid-air. Opt-in by query string, so it is absent in normal use.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('probe')) return;
    const flicker = attachFlickerProbe(gl);
    (window as unknown as { __atrium?: unknown }).__atrium = {
      /** What the framebuffer did over the next N rendered frames. */
      flicker: (frames: number, light?: boolean) => flicker.record(frames, light),
      /** Where the picture changed, accumulated over the last `flicker` run. */
      heat: () => flicker.heat(),
      /** What the HTML over the canvas did over the next N animation frames. */
      churn: (frames: number) => recordDomChurn(frames),
      /** Who is standing about talking to whom, for the conversation check. */
      chats: () =>
        [...controllers.current.values(), ...npcs.controllers()]
          .filter((c) => chatter.talking(c.id))
          .map((c) => ({
            id: c.id,
            with: chatter.partner(c.id),
            facing: c.pose().heading,
            // Whether a message caused it, or the office simply put two people
            // who had nothing on in the same part of the lounge.
            reported: chatter.reported(c.id),
            note: chatNote.current(c.id),
          })),
      figures: () =>
        [...controllers.current.values()].map((c) => ({
          id: c.id,
          phase: c.phase,
          platform: c.platform,
          zone: c.currentZone,
          position: c.position,
          progress: c.progress,
          // Sitting has been wrong twice and both times it looked fine in
          // aggregate, so the pose is reported rather than inferred: how far
          // into the chair the figure is, and how high the chair it believes
          // it is on actually is.
          seated: c.pose().seated,
          seatHeight: c.pose().seatHeight,
        })),
      platforms: () =>
        campus.platforms.map((p) => ({ id: p.id, position: p.position, size: p.size, level: p.level })),
      connectors: () =>
        campus.connectors.map((c) => ({ id: c.id, a: c.a, b: c.b, kind: c.kind, style: c.style, from: c.from, to: c.to })),
      /**
       * How many times the expensive, *visible* things have been rebuilt.
       *
       * A campus rebuild replans the architecture and re-merges every
       * platform, walkway and building into one geometry — which is a frame
       * where the whole office is thrown away and made again. Doing it twice
       * is a hitch; doing it on a timer is the flashing. There is no way to
       * see that from outside, so it is counted from inside.
       */
      rebuilds: () => ({ ...REBUILDS }),
      /**
       * Everybody the office draws, where their bodies actually are.
       *
       * The *drawn* position, which is the routed one plus however far the
       * figure has had to step aside, and the radius that body takes up. The
       * only honest way to ask whether two figures overlap is to ask about the
       * two things that are on the screen.
       */
      bodies: () =>
        [...controllers.current.values(), ...npcs.controllers()].map((c) => ({
          id: c.id,
          at: c.pose().position,
          // The route's own answer, without the step aside, so a test can tell
          // a pass that did not part them from a lean that had not arrived yet.
          routed: [...c.position] as [number, number, number],
          radius: c.bodyRadius,
          phase: c.phase,
          on: c.currentZone,
          seated: c.pose().seated > 0.5,
        })),
      /** What every agent says it is doing, and where it actually is. */
      work: () =>
        [...controllers.current.values()].map((c) => ({
          id: c.id,
          doing: c.doing,
          want: c.wantedZone,
          at: c.currentZone,
          phase: c.phase,
        })),
      /**
       * Screen position of a figure, so a test can put the pointer on it.
       *
       * Caretakers too. They are figures, they can be hovered, and they turn up
       * in half of the conversations — a probe that only knew about agents
       * answered null for one of the two people in every chat the office drew.
       */
      screenOf: (agentId: string) => {
        const controller =
          controllers.current.get(agentId) ??
          npcs.controllers().find((candidate) => candidate.id === agentId);
        if (!controller) return null;
        const pose = controller.pose();
        // Mid-body, scaled: a fixed offset misses the head on a big figure and
        // the feet on a small one.
        const point = new Vector3(pose.position[0], pose.position[1] + 0.42 * pose.scale, pose.position[2]);
        point.project(camera);
        return {
          x: ((point.x + 1) / 2) * size.width,
          y: ((1 - point.y) / 2) * size.height + size.top,
        };
      },
    };
    return () => flicker.dispose();
  }, [campus, gl, npcs, chatter]);


  // The floor plan changed: put everybody back on a platform that exists, and
  // let them re-claim a seat in the new pool.
  useEffect(() => {
    const now = officeNow();
    for (const controller of controllers.current.values()) controller.rehome(resolver, now);
    npcs.settle(resolver, now);
    // The card asks the crowd what somebody is doing; a conversation outranks
    // the errand they were on, because it is what they are visibly doing.
    npcNote.current = (id) => (chatter.talking(id) ? 'Stopped to talk to somebody' : npcs.describe(id));
    /*
     * Named only when the world said so.
     *
     * "Talking to Explore" is a claim about what your machine is doing and has
     * to be true, so it is reserved for a conversation a message actually
     * caused. Two figures who simply ran into each other in the lounge get the
     * truth about that too, which is that they are chatting.
     */
    chatNote.current = (id) => {
      if (!chatter.talking(id)) return null;
      const other = chatter.partner(id);
      if (!chatter.reported(id) || !other) return 'Chatting';
      return `Talking to ${nameOf(other, worldRef.current)}`;
    };
    return () => npcs.clear((id) => slots.release(id));
  }, [resolver, npcs, slots, npcNote, chatNote, chatter]);

  // Sync controllers with the world: spawn, retire, and push activity through.
  useEffect(() => {
    const now = officeNow();
    const live = new Set<string>();

    for (const agent of Object.values(world.agents)) {
      if (agent.status !== 'running' && agent.role !== 'main') continue;
      const session = world.sessions[agent.slotId];
      if (!session || session.phase === 'ended') continue;
      live.add(agent.id);

      const attention = agent.role === 'main' && session.phase === 'attention';
      const activity = activityFor(agent, session, Date.now());

      let controller = controllers.current.get(agent.id);
      if (!controller) {
        controller = new FigureController(
          agent.id,
          agent.role,
          scaleForTier(agent.model.tier),
          spawnPlace(resolver, agent.id, activity),
          resolver,
          now,
        );
        controllers.current.set(agent.id, controller);
      }

      controller.setActivity(activity, now, attention);
      controller.setTier(scaleForTier(agent.model.tier), now);
    }

    for (const [id, controller] of controllers.current) {
      if (!live.has(id)) controller.leave(now);
    }
    force((n) => n + 1);
  }, [world, resolver]);

  const instances = useMemo<FigureInstance[]>(() => {
    const out: FigureInstance[] = [];
    for (const [id, controller] of controllers.current) {
      if (controller.phase === 'gone') continue;
      const agent = world.agents[id];
      const session = agent ? world.sessions[agent.slotId] : undefined;
      const colour = paletteAt(session?.colorIndex ?? 0);
      const tint = depthTint(agent?.depth ?? 0);
      out.push({
        controller,
        colorBottom: colour.base,
        colorTop: mix(colour.top, '#ffffff', tint),
        translucent: agent?.isFork ?? false,
        highlight: id === subject ? 1 : 0,
      });
    }
    /*
     * They wear the stone, not a session palette: nothing about them should
     * invite you to work out which session they are. The shape already says
     * they are not one, so the colour is free to be quiet.
     *
     * Not *one* stone, though. A crowd in a single colour reads as a set of
     * copies, so each takes a slightly different mix of the two — the same
     * rock, cut on a different day.
     */
    let n = 0;
    for (const controller of npcs.controllers()) {
      const grain = ((n += 1) % 5) / 4;
      out.push({
        controller,
        colorBottom: mix(theme.platform.side, theme.tones.top, 0.1 + grain * 0.22),
        colorTop: mix(theme.tones.top, theme.platform.side, 0.2 + grain * 0.3),
        translucent: false,
        carryKind: 'cup',
        highlight: controller.id === subject ? 1 : 0,
      });
    }

    return out;
    // Rebuilt whenever the population changes; poses are written per frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, controllers.current.size, npcs, theme, subject]);

  /**
   * Everyone on the campus, for anything that has to react to them.
   *
   * A function rather than a list: it is read once a frame by the birds, and
   * building an array of positions on every world patch — which is ten times a
   * second — to serve a consumer that only wants the current one would be the
   * board-clock mistake again.
   */
  const crowd = useCallback(() => {
    const out: { at: [number, number, number]; npc: boolean }[] = [];
    for (const controller of controllers.current.values()) {
      if (controller.phase === 'gone') continue;
      out.push({ at: controller.pose().position, npc: false });
    }
    for (const controller of npcs.controllers()) out.push({ at: controller.pose().position, npc: true });
    return out;
  }, [npcs]);

  useFrame((_state, delta) => {
    // Clamp first, then advance the clock by exactly what the figures are told
    // has passed, so the two can never disagree.
    const step = Math.min(delta, 0.1);
    advanceOfficeClock(step);
    const now = officeNow();
    npcs.update(step, now, (id) => chatter.talking(id));
    for (const [id, controller] of controllers.current) {
      controller.update(step, now);
      if (controller.phase === 'gone') {
        slots.release(id);
        controllers.current.delete(id);
        if (subject === id) onHover(null);
      }
    }
    // Last, and over everybody at once: agents and caretakers walk the same
    // floors and were happily standing inside each other.
    separateFigures([...controllers.current.values(), ...npcs.controllers()]);

    /*
     * Then work out who has stopped to talk to whom.
     *
     * After the separation pass, so a pair are already standing a body's width
     * apart by the time they turn to face each other — run the other way round
     * and they spend the first second of every conversation nose to nose.
     *
     * Caretakers are always free. An agent joins in only while it is idle,
     * which is the office's own word for a session between turns: somebody
     * with work in front of them standing about chatting would be the office
     * saying something untrue about your machine.
     */
    const talkers: Talker[] = [];
    for (const controller of controllers.current.values()) {
      if (controller.phase === 'gone') continue;
      talkers.push({ controller, idle: controller.currentZone === 'lounge' });
    }
    for (const controller of npcs.controllers()) talkers.push({ controller, idle: true });
    chatter.update(talkers, step, now);
    runMeetings(meetings.current, controllers.current, chatter, now);
  });

  return (
    <>
      <Figures instances={instances} interaction={interaction} />
      <Envelopes pool={flights} />
      {/*
       * Rendered here rather than beside the architecture because what makes
       * them worth having is that they notice people, and the people are here.
       */}
      <Birds campus={campus} plan={architecture} seed={seed} theme={theme} grounded={raining} positions={crowd} />
    </>
  );
}

/**
 * What decides when the office redraws.
 *
 * `demand` renders once per `invalidate()`, so something has to ask. Doing that
 * from a `useFrame` would just be `always` spelled differently; this paces it
 * instead, and the pacing is the point:
 *
 * - **60 Hz, not the display's rate.** On a 120 Hz panel the office was drawing
 *   twice as many frames as it had anything to say, and the second one of each
 *   pair was usually identical. Held at 60, every frame is shown for exactly two
 *   refreshes.
 * - **Nothing at all while the window is hidden**, which is most of the day for
 *   a thing you glance at, and nothing while the canvas is the mode you are
 *   looking at — the office is still mounted behind it, and a mounted scene that
 *   keeps rendering is the cost the mount was meant to avoid.
 *
 * It paces by *counting* refreshes, not by measuring elapsed milliseconds. The
 * obvious version — render whenever at least a 60th of a second has passed —
 * measured a clean 16.7 ms median and then ran long on one frame in six: a frame
 * that takes a while to draw finishes after the next refresh has already gone,
 * the deadline is missed, and that frame is held for three refreshes instead of
 * two. Uneven cadence on flat-shaded geometry is exactly the kind of artifact
 * this scene shows off, so it is worth being exact about. Counting refreshes
 * cannot drift: every other one, whatever the frame cost.
 *
 * The stride is measured rather than assumed, because the right answer is 2 on a
 * ProMotion laptop, 1 on an external 60 Hz panel, and 4 on a 240 Hz monitor —
 * and the window can be dragged between them while running, so it is re-measured
 * whenever the refresh rate stops matching.
 */
function Ticker({ active }: { active: boolean }): null {
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    if (!active) return;
    const TARGET_HZ = 60;
    let raf = 0;
    let stride = 1;
    let phase = 0;
    // Refresh intervals still to be sampled before trusting a stride.
    let sampling = 8;
    let previous = 0;

    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick);

      if (sampling > 0 && previous > 0) {
        const hz = 1000 / (now - previous);
        // Only ever divides the refresh rate down, never up: a slow display must
        // not end up rendering every third frame because one interval was long.
        if (hz > TARGET_HZ * 1.4) stride = Math.max(1, Math.round(hz / TARGET_HZ));
        sampling -= 1;
      }
      previous = now;

      if (document.hidden) return;
      phase += 1;
      if (phase % stride !== 0) return;
      invalidate();
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, invalidate]);

  return null;
}

/** `#rrggbb` plus an alpha, for the CSS variables the labels read. */
function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

function platformCentre(position: [number, number], level: number): Vec3 {
  return [position[0], levelY(level), position[1]];
}

/**
 * Where a figure materialises: at the slot its activity calls for, falling back
 * to its own desk and then the lounge. Starting at the world origin and walking
 * out from there is how you get a figure standing in mid-air.
 */
function spawnPlace(
  resolver: ZoneResolver,
  agentId: string,
  activity: AgentView['activity'],
): {
  position: Vec3;
  platformId: string | null;
  zone: ZoneId | null;
  facing: number;
  slot?: SlotKind;
  seat?: number;
} {
  const wanted = ACTIVITY_ZONE[activity];
  for (const zone of [wanted.zone, 'desk', 'lounge'] as ZoneId[]) {
    const target = resolver.platformFor(zone, agentId);
    if (!target) continue;
    const slot = resolver.claimSlot(agentId, target.platformId, wanted.slot, target.position);
    return {
      position: slot.position,
      platformId: target.platformId,
      zone,
      facing: slot.facing,
      slot: wanted.slot,
      ...(slot.seat === undefined ? {} : { seat: slot.seat }),
    };
  }
  return { position: [0, 0, 0], platformId: null, zone: null, facing: 0 };
}

/**
 * The lounge is for a break, not a parking lot.
 *
 * A session that has just finished a turn strolls off for a coffee; one that
 * has been quiet for a while is at its desk. Without this every idle session
 * piles into the lounge and the office reads as a waiting room.
 */
const BREAK_MS = 3 * 60_000;

function activityFor(agent: AgentView, session: SessionView, now: number): AgentView['activity'] {
  if (session.phase === 'attention') return 'awaiting';
  const idle = agent.status !== 'running' && agent.role !== 'main' ? 'idle' : agent.activity;
  if (idle !== 'idle' || agent.role !== 'main') return idle;
  const since = now - (session.lastTurn?.endedAt ?? session.startedAt);
  return since < BREAK_MS ? 'idle' : 'responding';
}

function mix(a: string, b: string, t: number): string {
  const parse = (hex: string): [number, number, number] => {
    const value = Number.parseInt(hex.replace('#', ''), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  };
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const channel = (x: number, y: number): number => Math.round(x + (y - x) * t);
  return `#${((1 << 24) | (channel(ar, br) << 16) | (channel(ag, bg) << 8) | channel(ab, bb)).toString(16).slice(1)}`;
}


/**
 * How long a pair are given to find each other before the office gives up.
 *
 * A message is worth walking across the campus for; it is not worth walking
 * across the campus for a minute and arriving to talk about something that
 * happened a minute ago.
 */
const MEET_TIMEOUT_MS = 45_000;

/** And how long they are kept standing together once they have met. */
const MEET_HOLD_MS = 11_000;

interface Meeting {
  /** Stays where it is. */
  host: string;
  /** Walks over. */
  guest: string;
  by: number;
  sent: boolean;
}

/** Which figure stands for a message endpoint, if any does. */
function figureFor(
  endpoint: Endpoint,
  world: World,
  controllers: Map<string, FigureController>,
): string | null {
  if (endpoint.kind === 'agent') return controllers.has(endpoint.agentId) ? endpoint.agentId : null;
  if (endpoint.kind === 'session') {
    for (const agent of Object.values(world.agents)) {
      if (agent.role === 'main' && agent.slotId === endpoint.slotId && controllers.has(agent.id)) return agent.id;
    }
  }
  return null;
}

/**
 * Walk the pairs that have something to say to each other together, and start
 * them talking once they are.
 *
 * Both ends are pinned, not just the one that walks. The first version held
 * only the guest and sent it to where the host was standing at the moment the
 * message arrived — and the host, which has its own work and its own tally
 * pulling it toward its own zone, had usually left by the time anybody got
 * there. What that drew was a figure crossing the office to stand on an empty
 * square, which is worse than drawing nothing.
 */
function runMeetings(
  meetings: Map<string, Meeting>,
  controllers: Map<string, FigureController>,
  chatter: Conversations,
  now: number,
): void {
  for (const [key, meeting] of meetings) {
    const host = controllers.get(meeting.host);
    const guest = controllers.get(meeting.guest);
    if (!host || !guest || now > meeting.by) {
      meetings.delete(key);
      continue;
    }
    if (chatter.partner(meeting.host) === meeting.guest) {
      meetings.delete(key);
      continue;
    }

    if (gap(host, guest) <= REACH && host.phase === 'standing' && guest.phase === 'standing') {
      host.meetAt(host.platform ?? '', host.pose().position, now, MEET_HOLD_MS);
      guest.meetAt(guest.platform ?? '', guest.pose().position, now, MEET_HOLD_MS);
      chatter.summon(meeting.host, meeting.guest, now);
      meetings.delete(key);
      continue;
    }

    /*
     * Sent once, and only once the host has come to rest.
     *
     * Pinning a figure mid-stride leaves it standing halfway up a flight of
     * stairs, and re-routing a walking guest every frame is the glitch
     * `setActivity` already learned the hard way.
     */
    if (meeting.sent) continue;
    if (host.phase !== 'standing' || !host.platform) continue;
    const at = host.pose().position;
    host.meetAt(host.platform, at, now, MEET_TIMEOUT_MS + MEET_HOLD_MS);
    guest.meetAt(host.platform, [at[0] + 1.2, at[1], at[2] + 1.2], now, MEET_TIMEOUT_MS + MEET_HOLD_MS);
    meeting.sent = true;
  }

  // And let anybody the conversation has finished with get back to work.
  for (const [id, controller] of controllers) {
    if (controller.held && !chatter.talking(id) && !pendingIn(meetings, id)) controller.releaseHold();
  }
}

function pendingIn(meetings: Map<string, Meeting>, id: string): boolean {
  for (const meeting of meetings.values()) if (meeting.host === id || meeting.guest === id) return true;
  return false;
}

/** What to call somebody on a card: their session's name, or their role. */
function nameOf(agentId: string, world: World): string {
  const agent = world.agents[agentId];
  if (!agent) return 'someone who works here';
  const session = world.sessions[agent.slotId];
  if (agent.role === 'main') return session?.title ?? 'another session';
  return agent.agentType ?? agent.role;
}
