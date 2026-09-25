import type { Activity } from '../../shared/activity';
import { classifyBash } from './bashClassify';

/**
 * Maps a tool call to what the agent is *doing*, which is what decides where it
 * walks in the office and what the canvas card says.
 *
 * Bash gets special treatment because it is ~80% of all tool calls: without
 * classifying the command itself, almost every agent would stand at one bench.
 */

export interface ToolActivity {
  activity: Activity;
  /** Short human phrase: "Reading normalize.ts", "running tests". */
  label: string;
  /** The thing being acted on, shown on hover. */
  target?: string;
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function short(value: unknown, max = 48): string {
  if (typeof value !== 'string') return '';
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

const BASH_ACTIVITY: Record<ReturnType<typeof classifyBash>, Activity> = {
  read: 'reading',
  search: 'searching',
  test: 'testing',
  build: 'testing',
  git: 'running',
  net: 'browsing',
  publish: 'publishing',
  other: 'running',
};

const BASH_LABEL: Record<ReturnType<typeof classifyBash>, string> = {
  read: 'reading files',
  search: 'searching',
  test: 'running tests',
  build: 'building',
  git: 'working with git',
  net: 'fetching',
  publish: 'publishing',
  other: 'running a command',
};

export function toolToActivity(name: string, input: Record<string, unknown> = {}): ToolActivity {
  switch (name) {
    case 'Read':
    case 'NotebookRead': {
      const file = basename(String(input['file_path'] ?? ''));
      return { activity: 'reading', label: file ? `reading ${file}` : 'reading', target: file };
    }
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const file = basename(String(input['file_path'] ?? ''));
      return { activity: 'editing', label: file ? `editing ${file}` : 'editing', target: file };
    }
    case 'Grep': {
      const pattern = short(input['pattern'], 32);
      return { activity: 'searching', label: pattern ? `grep ${pattern}` : 'searching', target: pattern };
    }
    case 'Glob':
    case 'LS': {
      const pattern = short(input['pattern'] ?? input['path'], 32);
      return { activity: 'searching', label: pattern ? `finding ${pattern}` : 'searching', target: pattern };
    }
    case 'ToolSearch': {
      const query = short(input['query'], 32);
      return { activity: 'searching', label: query ? `looking up ${query}` : 'searching tools', target: query };
    }
    case 'Bash':
    case 'BashOutput': {
      const command = String(input['command'] ?? '');
      const description = typeof input['description'] === 'string' ? input['description'] : undefined;
      const category = classifyBash(command, description);
      const label = description ? short(description) : BASH_LABEL[category];
      return { activity: BASH_ACTIVITY[category], label, target: short(command, 64) };
    }
    case 'Agent':
    case 'Task': {
      const type = String(input['subagent_type'] ?? 'agent');
      const description = short(input['description'], 40);
      return {
        activity: 'delegating',
        label: description ? `${type}: ${description}` : `delegating to ${type}`,
        target: type,
      };
    }
    case 'Workflow': {
      const workflow = short(input['name'] ?? 'workflow', 32);
      return { activity: 'orchestrating', label: `workflow ${workflow}`, target: workflow };
    }
    case 'Monitor':
    case 'ScheduleWakeup':
    case 'CronCreate':
    case 'CronList':
    case 'CronDelete':
    case 'TaskOutput':
    case 'TaskStop':
      return { activity: 'watching', label: 'watching', target: short(input['description'] ?? input['reason'], 40) };
    case 'SendMessage':
    case 'ListAgents':
    case 'ReadNotifications':
    case 'SubagentHandback':
      return { activity: 'messaging', label: 'messaging', target: short(input['to'], 32) };
    case 'SendUserFile':
    case 'Artifact':
    case 'ArtifactData':
    case 'ArtifactComments':
      return { activity: 'publishing', label: 'publishing', target: short(input['title'] ?? input['caption'], 40) };
    case 'WebFetch':
    case 'WebSearch':
      return {
        activity: 'browsing',
        label: 'browsing',
        target: short(input['url'] ?? input['query'], 48),
      };
    case 'Skill': {
      const skill = short(input['skill'], 32);
      return { activity: 'learning', label: skill ? `skill ${skill}` : 'reading a skill', target: skill };
    }
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return { activity: 'tasking', label: 'updating the task list' };
    case 'AskUserQuestion':
      return { activity: 'awaiting', label: 'asking you a question' };
    case 'ExitPlanMode':
      return { activity: 'awaiting', label: 'waiting on plan approval' };
    case 'EnterPlanMode':
      return { activity: 'planning', label: 'planning' };
    case 'EnterWorktree':
    case 'ExitWorktree':
      return { activity: 'running', label: 'switching worktree' };
    default:
      if (name.startsWith('mcp__')) {
        const [, server = '', tool = ''] = name.split('__');
        // Browser MCPs are still browsing, wherever they come from.
        if (/chrome|browser/i.test(server)) return { activity: 'browsing', label: 'browsing', target: tool };
        return { activity: 'tooling', label: `${server} ${tool}`.trim(), target: server };
      }
      return { activity: 'running', label: short(name, 32) || 'working' };
  }
}
