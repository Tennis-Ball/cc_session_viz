import { ACTIVITY_LABEL } from '@shared/activity';
import { fmtDuration, fmtTokens } from '@shared/format';
import type { AgentView, SessionView } from '@shared/model';
import { paletteAt } from '@shared/palette';
import { useWorld } from '../store/world';

/**
 * The development view: every session and agent the engine knows about, in the
 * order the office will place them. It stays in the app behind a toggle, since
 * it is the fastest way to confirm the data layer against real sessions.
 */
export function Inspector(): React.JSX.Element {
  const world = useWorld((s) => s.world);
  const sessions = Object.values(world.sessions).sort((a, b) => a.startedAt - b.startedAt);
  const agents = Object.values(world.agents);

  return (
    <div className="inspector">
      <div className="inspector__head">
        <strong>{sessions.length} sessions</strong>
        <span>{agents.length} agents</span>
        <span>rev {world.rev}</span>
        <span>source {world.health.source}</span>
        {world.health.unknownSignals > 0 && <span>unknown signals {world.health.unknownSignals}</span>}
      </div>

      {sessions.length === 0 && <div className="empty">No sessions yet.</div>}

      {sessions.map((session) => (
        <SessionRow
          key={session.id}
          session={session}
          agents={agents.filter((a) => a.slotId === session.id && a.id !== session.mainAgentId)}
          main={world.agents[session.mainAgentId]}
        />
      ))}
    </div>
  );
}

function SessionRow({
  session,
  agents,
  main,
}: {
  session: SessionView;
  agents: AgentView[];
  main: AgentView | undefined;
}): React.JSX.Element {
  const color = paletteAt(session.colorIndex);
  const pct = Math.round(session.context.pct);
  const meterClass = pct >= 85 ? 'meter meter--crit' : pct >= 60 ? 'meter meter--warn' : 'meter';

  return (
    <section className="session">
      <header className="session__head">
        <span className="session__swatch" style={{ background: color.base }} />
        <span className="session__title">{session.title}</span>
        <span className="session__meta">
          {session.repo}
          {session.gitBranch ? ` · ${session.gitBranch}` : ''} · {session.model.label}
        </span>
        <span className="spacer" />
        <span className="session__meta">
          {fmtTokens(session.context.used)}/{fmtTokens(session.context.window)}
        </span>
        <span className={meterClass}>
          <i style={{ width: `${Math.min(100, pct)}%` }} />
        </span>
        <span className="session__meta">{pct}%</span>
        <i className={`dot dot--${session.phase === 'working' ? 'working' : session.phase}`} />
      </header>

      <div className="agents">
        {main && <AgentRow agent={main} />}
        {agents.map((agent) => (
          <AgentRow key={agent.id} agent={agent} />
        ))}
      </div>
    </section>
  );
}

function AgentRow({ agent }: { agent: AgentView }): React.JSX.Element {
  const done = agent.status !== 'running';
  return (
    <div className={`agent ${done ? 'agent--done' : ''}`}>
      <span className="agent__role">
        {agent.role === 'main' ? 'main' : agent.agentType}
        {agent.depth > 0 ? ` ·${agent.depth}` : ''}
      </span>
      <span className="agent__activity">{done ? agent.status : ACTIVITY_LABEL[agent.activity]}</span>
      <span>{agent.description}</span>
      <span className="spacer" />
      <span>
        {agent.stats.toolUses} tools · {fmtTokens(agent.stats.tokens)} · {fmtDuration(agent.stats.durationMs)}
      </span>
    </div>
  );
}
