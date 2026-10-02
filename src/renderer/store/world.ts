import { create } from 'zustand';
import { emptyWorld, type World } from '@shared/model';
import type { EngineMsg } from '@shared/protocol';

interface WorldState {
  world: World;
  connected: boolean;
  /** Set when a patch arrives out of order; the client asks for a resync. */
  desynced: boolean;
  applyHello(world: World): void;
  applyPatch(patch: Extract<EngineMsg, { type: 'patch' }>): void;
  setConnected(connected: boolean): void;
}

export const useWorld = create<WorldState>((set) => ({
  world: emptyWorld(),
  connected: false,
  desynced: false,

  applyHello: (world) => set({ world, connected: true, desynced: false }),

  applyPatch: (patch) =>
    set((state) => {
      if (patch.baseRev !== state.world.rev) return { desynced: true };
      const world: World = { ...state.world, rev: patch.rev };

      if (patch.sessions) {
        const sessions = { ...world.sessions };
        for (const s of patch.sessions.upsert ?? []) sessions[s.id] = s;
        for (const id of patch.sessions.remove ?? []) delete sessions[id];
        world.sessions = sessions;
      }
      if (patch.agents) {
        const agents = { ...world.agents };
        for (const a of patch.agents.upsert ?? []) agents[a.id] = a;
        for (const id of patch.agents.remove ?? []) delete agents[id];
        world.agents = agents;
      }
      if (patch.workflows) {
        const workflows = { ...world.workflows };
        for (const w of patch.workflows.upsert ?? []) workflows[w.runId] = w;
        for (const id of patch.workflows.remove ?? []) delete workflows[id];
        world.workflows = workflows;
      }
      if (patch.watches) {
        const watches = { ...world.watches };
        for (const w of patch.watches.upsert ?? []) watches[w.id] = w;
        for (const id of patch.watches.remove ?? []) delete watches[id];
        world.watches = watches;
      }
      if (patch.links?.append?.length) {
        world.links = [...world.links, ...patch.links.append].slice(-100);
      }
      if (patch.usage !== undefined) world.usage = patch.usage;
      if (patch.health) world.health = patch.health;

      return { world, desynced: false };
    }),

  setConnected: (connected) => set({ connected }),
}));
