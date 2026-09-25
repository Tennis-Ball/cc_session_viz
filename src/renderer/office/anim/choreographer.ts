import type { VisualEvent } from '@shared/events';
import type { Endpoint, SlotId, World } from '@shared/model';
import { paletteAt } from '@shared/palette';
import type { ZoneId } from '@shared/activity';
import type { Vec3 } from '../world/navGraph';
import type { FigureController } from './figureController';
import type { FlightPool } from './flights';

/**
 * Events → gestures.
 *
 * The world already says where everybody is and what they are doing; this is
 * only about the moment something happens. Nothing here is load-bearing: if an
 * event is dropped (the window was hidden, the engine restarted) the office is
 * still correct, it just missed a gesture.
 */

export interface Stage {
  controllers: Map<string, FigureController>;
  world(): World;
  flights: FlightPool;
  /** Fallback position for an endpoint with nobody on screen. */
  zonePosition(zone: ZoneId): Vec3 | null;
}

export function applyVisualEvent(event: VisualEvent, stage: Stage, now: number): void {
  switch (event.t) {
    case 'interrupted':
      main(stage, event.slot)?.play('squash', now);
      break;

    case 'denied':
      stage.controllers.get(event.agent)?.play('turnBack', now);
      break;

    case 'apiError':
      stage.controllers.get(event.agent)?.play('startle', now);
      break;

    case 'turnEnded':
      main(stage, event.slot)?.play('stretch', now);
      break;

    case 'compactProbable':
    case 'compacted':
      // The stack goes to the Archive; the walk itself comes from the activity.
      main(stage, event.slot)?.play('carry', now);
      break;

    case 'subagentSpawned':
      stage.controllers.get(event.parent)?.play('nod', now);
      stage.controllers.get(event.child)?.play('greet', now);
      break;

    case 'subagentFinished':
      stage.controllers.get(event.agent)?.play('debrief', now);
      break;

    case 'wakeupFired':
    case 'watchPulse': {
      const watch = stage.world().watches[event.watch];
      if (watch) main(stage, watch.slotId)?.play('lookUp', now);
      break;
    }

    case 'skillUsed':
    case 'published':
    case 'fileEdited':
      stage.controllers.get(event.agent)?.play('nod', now);
      break;

    case 'promptQueued':
      main(stage, event.slot)?.play('receive', now);
      break;

    case 'message': {
      const from = endpointPlace(stage, event.link.from);
      const to = endpointPlace(stage, event.link.to);
      from?.controller?.play('toss', now);
      to?.controller?.play('receive', now);
      if (from && to) {
        stage.flights.send(from.position, to.position, colorFor(stage, event.link.from), now);
      }
      break;
    }

    case 'modelChanged':
      // Scale is set from the world on the next sync; the beat is the reaction.
      stage.controllers.get(event.agent)?.play('stretch', now);
      break;

    default:
      break;
  }
}

/** The figure that stands for a session: its main agent. */
function main(stage: Stage, slot: SlotId): FigureController | undefined {
  const world = stage.world();
  for (const agent of Object.values(world.agents)) {
    if (agent.role === 'main' && agent.slotId === slot) return stage.controllers.get(agent.id);
  }
  return undefined;
}

interface Place {
  position: Vec3;
  controller?: FigureController;
}

/**
 * Where a message endpoint is standing.
 *
 * A session that is not on screen (an external name, an agent that already
 * dissolved) still gets a place: the Mailroom. An envelope arriving from the
 * Mailroom reads as post from elsewhere, which is exactly what it is.
 */
function endpointPlace(stage: Stage, endpoint: Endpoint): Place | null {
  if (endpoint.kind === 'agent') {
    const controller = stage.controllers.get(endpoint.agentId);
    if (controller) return { position: heldPosition(controller), controller };
  }
  if (endpoint.kind === 'session') {
    const controller = main(stage, endpoint.slotId);
    if (controller) return { position: heldPosition(controller), controller };
  }
  const mailroom = stage.zonePosition('mailroom');
  return mailroom ? { position: mailroom } : null;
}

/** Roughly where a figure's hands are, so envelopes leave from the right height. */
function heldPosition(controller: FigureController): Vec3 {
  const pose = controller.pose();
  return [pose.position[0], pose.position[1] + 0.5 * pose.scale, pose.position[2]];
}

function colorFor(stage: Stage, endpoint: Endpoint): string {
  const world = stage.world();
  if (endpoint.kind === 'session') return paletteAt(world.sessions[endpoint.slotId]?.colorIndex ?? 0).top;
  if (endpoint.kind === 'agent') {
    const agent = world.agents[endpoint.agentId];
    const session = agent ? world.sessions[agent.slotId] : undefined;
    return paletteAt(session?.colorIndex ?? 0).top;
  }
  return paletteAt(0).top;
}
