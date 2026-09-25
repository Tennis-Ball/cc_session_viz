import type { VisualEvent } from '../../shared/events';
import {
  emptyWorld,
  type AgentView,
  type Group,
  type MessageLink,
  type SessionView,
  type UsageSnapshot,
  type WatchTask,
  type WorkflowRun,
  type World,
  type WorldHealth,
  type DataMode,
} from '../../shared/model';
import type { EngineMsg } from '../../shared/protocol';

const MAX_LINKS = 100;

type EntityKey = 'sessions' | 'agents' | 'workflows' | 'watches' | 'groups';

/**
 * The canonical world plus dirty tracking. Patches carry whole replacement
 * objects: entities are small, and it keeps the renderer merge trivial.
 */
export class WorldStore {
  private world: World = emptyWorld();
  private readonly dirty: Record<EntityKey, Set<string>> = {
    sessions: new Set(),
    agents: new Set(),
    workflows: new Set(),
    watches: new Set(),
    groups: new Set(),
  };
  private readonly removed: Record<EntityKey, Set<string>> = {
    sessions: new Set(),
    agents: new Set(),
    workflows: new Set(),
    watches: new Set(),
    groups: new Set(),
  };
  private newLinks: MessageLink[] = [];
  private usageDirty = false;
  private healthDirty = false;

  /** Events collected since the last drain; dropped when nobody is watching. */
  private events: VisualEvent[] = [];

  /**
   * Which world is being shown, and the one place it is enforced.
   *
   * "Real sessions, or the generated office. Never both" was the design, and
   * it was true of the *intent* of every caller and of none of the mechanism.
   * Both sources write here, and this took whatever it was handed — so a real
   * session could reach the screen in simulation mode three different ways: in
   * the burst before the remembered mode had been restored at launch, from a
   * filesystem read that was already in flight when the live source was reset,
   * and through the transcript hub, which asked the live source first whatever
   * the mode was.
   *
   * Filtering here rather than at the publisher makes it structural instead of
   * a race: there is no moment at which a real session is resident but not yet
   * filtered, because it never gets in.
   */
  private mode: DataMode = 'real';

  setMode(mode: DataMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    // Whatever the other mode left behind goes now. Simulated sessions are
    // marked; everything else in a simulated world is a leftover, and the same
    // in reverse.
    for (const session of Object.values(this.world.sessions)) {
      if (!this.allows(session.ambient)) this.removeSession(session.id);
    }
    for (const agent of Object.values(this.world.agents)) {
      if (!this.allows(agent.ambient)) this.removeAgent(agent.id);
    }
    for (const run of Object.values(this.world.workflows)) {
      if (!this.owned(run.slotId)) this.removeWorkflow(run.runId);
    }
    for (const watch of Object.values(this.world.watches)) {
      if (!this.owned(watch.slotId)) this.removeWatch(watch.id);
    }
    this.world.links = this.world.links.filter((link) => this.reaches(link));
    this.newLinks = [];
  }

  /** Does this world want entities of this provenance? */
  private allows(ambient: boolean): boolean {
    return ambient === (this.mode === 'simulation');
  }

  /**
   * Workflows, watches and message links carry no provenance of their own, so
   * they are judged by the session they belong to. An orphan is dropped: it
   * cannot be drawn without one anyway.
   */
  private owned(slotId: string | undefined): boolean {
    if (!slotId) return false;
    const session = this.world.sessions[slotId];
    return session !== undefined && this.allows(session.ambient);
  }

  /**
   * Does either end of this message belong to a session this world has?
   *
   * An endpoint naming nothing this world knows about does not count, so a
   * message between two real sessions cannot arrive in a simulated office by
   * way of an external label at one end of it.
   */
  private reaches(link: MessageLink): boolean {
    return [link.from, link.to].some((end) => {
      if (end.kind === 'session') return this.owned(end.slotId);
      if (end.kind === 'agent') {
        const agent = this.world.agents[end.agentId];
        return agent !== undefined && this.allows(agent.ambient);
      }
      return false;
    });
  }

  snapshot(): World {
    return this.world;
  }

  get rev(): number {
    return this.world.rev;
  }

  upsertSession(session: SessionView): void {
    if (!this.allows(session.ambient)) return;
    this.world.sessions[session.id] = session;
    this.mark('sessions', session.id);
  }

  removeSession(id: string): void {
    if (!(id in this.world.sessions)) return;
    delete this.world.sessions[id];
    this.unmark('sessions', id);
  }

  upsertAgent(agent: AgentView): void {
    if (!this.allows(agent.ambient)) return;
    this.world.agents[agent.id] = agent;
    this.mark('agents', agent.id);
  }

  removeAgent(id: string): void {
    if (!(id in this.world.agents)) return;
    delete this.world.agents[id];
    this.unmark('agents', id);
  }

  upsertWorkflow(run: WorkflowRun): void {
    if (!this.owned(run.slotId)) return;
    this.world.workflows[run.runId] = run;
    this.mark('workflows', run.runId);
  }

  removeWorkflow(id: string): void {
    if (!(id in this.world.workflows)) return;
    delete this.world.workflows[id];
    this.unmark('workflows', id);
  }

  upsertWatch(watch: WatchTask): void {
    if (!this.owned(watch.slotId)) return;
    this.world.watches[watch.id] = watch;
    this.mark('watches', watch.id);
  }

  removeWatch(id: string): void {
    if (!(id in this.world.watches)) return;
    delete this.world.watches[id];
    this.unmark('watches', id);
  }

  upsertGroup(group: Group): void {
    this.world.groups[group.id] = group;
    this.mark('groups', group.id);
  }

  removeGroup(id: string): void {
    if (!(id in this.world.groups)) return;
    delete this.world.groups[id];
    this.unmark('groups', id);
  }

  appendLink(link: MessageLink): void {
    if (!this.reaches(link)) return;
    this.world.links = [...this.world.links, link].slice(-MAX_LINKS);
    this.newLinks.push(link);
  }

  setUsage(usage: UsageSnapshot | null): void {
    this.world.usage = usage;
    this.usageDirty = true;
  }

  patchHealth(patch: Partial<WorldHealth>): void {
    this.world.health = { ...this.world.health, ...patch };
    this.healthDirty = true;
  }

  emit(event: VisualEvent): void {
    this.events.push(event);
  }

  drainEvents(): VisualEvent[] {
    if (this.events.length === 0) return [];
    const out = this.events;
    this.events = [];
    return out;
  }

  /** Builds the next patch, or null when nothing changed. */
  drainPatch(): Extract<EngineMsg, { type: 'patch' }> | null {
    const hasEntity = (Object.keys(this.dirty) as EntityKey[]).some(
      (key) => this.dirty[key].size > 0 || this.removed[key].size > 0,
    );
    if (!hasEntity && this.newLinks.length === 0 && !this.usageDirty && !this.healthDirty) return null;

    const baseRev = this.world.rev;
    this.world.rev = baseRev + 1;

    const patch: Extract<EngineMsg, { type: 'patch' }> = {
      type: 'patch',
      rev: this.world.rev,
      baseRev,
    };

    if (this.dirty.sessions.size || this.removed.sessions.size) {
      patch.sessions = {
        upsert: [...this.dirty.sessions].map((id) => this.world.sessions[id]).filter((s): s is SessionView => !!s),
        remove: [...this.removed.sessions],
      };
    }
    if (this.dirty.agents.size || this.removed.agents.size) {
      patch.agents = {
        upsert: [...this.dirty.agents].map((id) => this.world.agents[id]).filter((a): a is AgentView => !!a),
        remove: [...this.removed.agents],
      };
    }
    if (this.dirty.workflows.size || this.removed.workflows.size) {
      patch.workflows = {
        upsert: [...this.dirty.workflows].map((id) => this.world.workflows[id]).filter((w): w is WorkflowRun => !!w),
        remove: [...this.removed.workflows],
      };
    }
    if (this.dirty.watches.size || this.removed.watches.size) {
      patch.watches = {
        upsert: [...this.dirty.watches].map((id) => this.world.watches[id]).filter((w): w is WatchTask => !!w),
        remove: [...this.removed.watches],
      };
    }
    if (this.dirty.groups.size || this.removed.groups.size) {
      patch.groups = {
        upsert: [...this.dirty.groups].map((id) => this.world.groups[id]).filter((g): g is Group => !!g),
        remove: [...this.removed.groups],
      };
    }
    if (this.newLinks.length) {
      patch.links = { append: this.newLinks };
      this.newLinks = [];
    }
    if (this.usageDirty) {
      patch.usage = this.world.usage;
      this.usageDirty = false;
    }
    if (this.healthDirty) {
      patch.health = this.world.health;
      this.healthDirty = false;
    }

    for (const key of Object.keys(this.dirty) as EntityKey[]) {
      this.dirty[key].clear();
      this.removed[key].clear();
    }
    return patch;
  }

  private mark(key: EntityKey, id: string): void {
    this.dirty[key].add(id);
    this.removed[key].delete(id);
  }

  private unmark(key: EntityKey, id: string): void {
    this.dirty[key].delete(id);
    this.removed[key].add(id);
  }
}
