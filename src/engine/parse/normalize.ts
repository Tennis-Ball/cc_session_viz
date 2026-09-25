import type { Signal, TaskNotification } from './signals';

/**
 * The only module that knows Claude Code's JSONL field names.
 *
 * Everything here is deliberately tolerant: the transcript format shifts between
 * point releases (2.1.251 -> 2.1.277 added several line and attachment types),
 * so unknown shapes become an `unknown` signal instead of an exception.
 */

const MAX_TEXT = 8000;

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clip(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function timeOf(line: Json, fallback: number): number {
  const ts = str(line['timestamp']);
  if (ts) {
    const parsed = Date.parse(ts);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

/** tool_result content is either a string or a list of content blocks. */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const obj = asObject(block);
    if (!obj) continue;
    const text = str(obj['text']);
    if (text) parts.push(text);
    else if (str(obj['type']) === 'image') parts.push('[image]');
  }
  return parts.join('\n');
}

const TASK_TAG = /<task-notification>([\s\S]*?)<\/task-notification>/;

function tag(block: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
  return match?.[1];
}

/**
 * Background agents, background Bash and Monitor all report completion through
 * the same XML-ish envelope injected into the parent transcript.
 */
export function parseTaskNotification(text: string): TaskNotification | null {
  const match = TASK_TAG.exec(text);
  if (!match?.[1]) return null;
  const block = match[1];
  const taskId = tag(block, 'task-id');
  if (!taskId) return null;

  const usage = tag(block, 'usage') ?? '';
  const notification: TaskNotification = { taskId };
  const toolUseId = tag(block, 'tool-use-id');
  const status = tag(block, 'status');
  const summary = tag(block, 'summary');
  const result = tag(block, 'result');
  const event = tag(block, 'event');
  if (toolUseId) notification.toolUseId = toolUseId;
  if (status) notification.status = status;
  if (summary) notification.summary = summary;
  if (result) notification.result = clip(result, 4000);
  if (event) notification.event = clip(event, 2000);

  const tokens = Number(tag(usage, 'subagent_tokens'));
  const toolUses = Number(tag(usage, 'tool_uses'));
  const durationMs = Number(tag(usage, 'duration_ms'));
  if (Number.isFinite(tokens)) notification.tokens = tokens;
  if (Number.isFinite(toolUses)) notification.toolUses = toolUses;
  if (Number.isFinite(durationMs)) notification.durationMs = durationMs;
  return notification;
}

const INTERRUPT_RE = /\[Request interrupted by user(?: for tool use)?\]/;
const CROSS_SESSION_RE = /<cross-session-message\s+from="([^"]*)"/;
const AGENT_MESSAGE_RE = /<agent-message\s+from="([^"]*)"/;
const PASTED_RE = /\[Pasted text #\d+/g;
const IMAGE_RE = /\[Image #\d+/g;

export interface NormalizeContext {
  /** Wall clock used when a line has no usable timestamp. */
  now: number;
}

/** Translates one JSONL line into zero or more signals. */
export function normalizeLine(raw: string, ctx: NormalizeContext): Signal[] {
  let line: Json | null;
  try {
    line = asObject(JSON.parse(raw));
  } catch {
    return [];
  }
  if (!line) return [];

  const at = timeOf(line, ctx.now);
  const type = str(line['type']) ?? '';

  switch (type) {
    case 'assistant':
      return normalizeAssistant(line, at);
    case 'user':
      return normalizeUser(line, at);
    case 'system':
      return normalizeSystem(line, at);
    case 'attachment':
      return normalizeAttachment(line, at);
    case 'ai-title': {
      const value = str(line['aiTitle']);
      return value ? [{ at, s: 'title', kind: 'aiTitle', value }] : [];
    }
    case 'agent-name': {
      const value = str(line['agentName']);
      return value ? [{ at, s: 'title', kind: 'agentName', value }] : [];
    }
    case 'last-prompt': {
      const value = str(line['lastPrompt']);
      return value ? [{ at, s: 'title', kind: 'lastPrompt', value: clip(value, 400) }] : [];
    }
    case 'permission-mode': {
      const mode = str(line['permissionMode']);
      return mode ? [{ at, s: 'permissionMode', mode }] : [];
    }
    case 'bridge-session':
      return [{ at, s: 'bridge', bridgeSessionId: str(line['bridgeSessionId']) ?? null }];
    case 'pr-link': {
      const number = num(line['prNumber']);
      return number
        ? [
            {
              at,
              s: 'prLink',
              number,
              url: str(line['prUrl']) ?? '',
              repo: str(line['prRepository']) ?? '',
            },
          ]
        : [];
    }
    case 'cost-state':
      return [
        {
          at,
          s: 'cost',
          usd: num(line['totalCostUSD']) ?? 0,
          linesAdded: num(line['totalLinesAdded']) ?? 0,
          linesRemoved: num(line['totalLinesRemoved']) ?? 0,
        },
      ];
    case 'worktree-state': {
      const ws = asObject(line['worktreeSession']);
      if (!ws) return [];
      const signal: Signal = {
        at,
        s: 'worktree',
        name: str(ws['worktreeName']) ?? '',
        branch: str(ws['worktreeBranch']) ?? '',
        path: str(ws['worktreePath']) ?? '',
      };
      const originalCwd = str(ws['originalCwd']);
      return [originalCwd ? { ...signal, originalCwd } : signal];
    }
    case 'relocated': {
      const cwd = str(line['relocatedCwd']);
      return cwd ? [{ at, s: 'relocated', cwd }] : [];
    }
    case 'queue-operation': {
      const content = str(line['content']) ?? '';
      const op = str(line['operation']) ?? 'enqueue';
      const notification = parseTaskNotification(content);
      // The same notification also arrives as a user line; the reducer dedupes.
      if (notification) return [{ at, s: 'taskNotification', notification }];
      return [{ at, s: 'queueOp', op, content: clip(content, 400) }];
    }
    // Bookkeeping lines the visualizer has no use for.
    case 'file-history-snapshot':
    case 'file-history-delta':
    case 'history-suppression':
    case 'atis-latch':
    case 'frame-link':
    case 'mode':
      return [];
    default:
      // Artifact bookkeeping (`artifact-autoreact-ledger`, …) is internal state.
      if (type.startsWith('artifact-')) return [];
      return type ? [{ at, s: 'unknown', kind: type }] : [];
  }
}

function normalizeAssistant(line: Json, at: number): Signal[] {
  const message = asObject(line['message']);
  if (!message) return [];
  const messageId = str(message['id']) ?? str(line['requestId']) ?? `${at}`;
  const model = str(message['model']) ?? 'unknown';
  const signals: Signal[] = [];

  const usage = asObject(message['usage']);
  if (usage) {
    const input = num(usage['input_tokens']) ?? 0;
    const cacheRead = num(usage['cache_read_input_tokens']) ?? 0;
    const cacheCreate = num(usage['cache_creation_input_tokens']) ?? 0;
    const details = asObject(usage['output_tokens_details']);
    const signal: Signal = {
      at,
      s: 'usage',
      messageId,
      model,
      // Context in use is everything the model had to read this turn.
      used: input + cacheRead + cacheCreate,
      output: num(usage['output_tokens']) ?? 0,
    };
    const thinkingTokens = num(details?.['thinking_tokens']);
    const effort = str(line['effort']);
    const speed = str(usage['speed']);
    const error = str(line['error']);
    const stopReason = str(message['stop_reason']);
    signals.push({
      ...signal,
      ...(thinkingTokens !== undefined ? { thinkingTokens } : {}),
      ...(effort ? { effort } : {}),
      ...(speed ? { speed } : {}),
      ...(error ? { error } : {}),
      ...(stopReason ? { stopReason } : {}),
      ...(line['isApiErrorMessage'] === true ? { apiError: true } : {}),
    });
  }

  const content = message['content'];
  if (Array.isArray(content)) {
    for (const rawBlock of content) {
      const block = asObject(rawBlock);
      if (!block) continue;
      switch (str(block['type'])) {
        case 'text': {
          const text = str(block['text']);
          if (text?.trim()) signals.push({ at, s: 'text', messageId, text: clip(text) });
          break;
        }
        case 'thinking': {
          // Thinking is redacted ~96% of the time: only a signature survives.
          const text = str(block['thinking']);
          signals.push({ at, s: 'thinking', messageId, text: text?.trim() ? clip(text, 1200) : null });
          break;
        }
        case 'tool_use': {
          const id = str(block['id']);
          const name = str(block['name']);
          if (id && name) {
            signals.push({ at, s: 'toolUse', messageId, id, name, input: asObject(block['input']) ?? {} });
          }
          break;
        }
        default:
          break;
      }
    }
  }

  return signals;
}

function normalizeUser(line: Json, at: number): Signal[] {
  const message = asObject(line['message']);
  const content = message?.['content'];
  const signals: Signal[] = [];
  const origin = asObject(line['origin']);
  const originKind = str(origin?.['kind']) ?? 'human';

  if (typeof content === 'string' || Array.isArray(content)) {
    const blocks = Array.isArray(content) ? content : [];
    for (const rawBlock of blocks) {
      const block = asObject(rawBlock);
      if (!block) continue;
      if (str(block['type']) !== 'tool_result') continue;
      const id = str(block['tool_use_id']);
      if (!id) continue;
      const text = clip(contentToText(block['content']), 4000);
      const denial = str(line['toolDenialKind']);
      const result = asObject(line['toolUseResult']) ?? undefined;
      signals.push({
        at,
        s: 'toolResult',
        id,
        isError: block['is_error'] === true || !!denial,
        text,
        ...(denial ? { denial } : {}),
        ...(result ? { result } : {}),
      });
    }

    const plain = typeof content === 'string' ? content : contentToText(blocks.filter((b) => asObject(b)));
    if (plain.trim() && !blocks.some((b) => str(asObject(b)?.['type']) === 'tool_result')) {
      signals.push(...normalizeUserText(line, plain, at, originKind));
    }
  }

  return signals;
}

function normalizeUserText(line: Json, text: string, at: number, originKind: string): Signal[] {
  if (INTERRUPT_RE.test(text)) {
    return [{ at, s: 'interrupt', forTool: /for tool use/.test(text) }];
  }

  const notification = parseTaskNotification(text);
  if (notification) return [{ at, s: 'taskNotification', notification }];

  const crossSession = CROSS_SESSION_RE.exec(text);
  if (crossSession) {
    return [{ at, s: 'inbound', via: 'crossSession', from: crossSession[1] ?? '', text: clip(text, 1200) }];
  }
  if (originKind === 'coordinator') {
    return [{ at, s: 'inbound', via: 'coordinator', from: 'coordinator', text: clip(text, 1200) }];
  }
  if (originKind === 'peer') {
    const from = AGENT_MESSAGE_RE.exec(text)?.[1] ?? str(asObject(line['origin'])?.['from']) ?? '';
    return [{ at, s: 'inbound', via: 'peer', from, text: clip(text, 1200) }];
  }

  // A local command echo (/clear, /compact) is not a prompt.
  if (/^<command-name>/.test(text.trim())) {
    return [{ at, s: 'notice', level: 'info', text: clip(text, 200), origin: 'localCommand' }];
  }
  if (line['isMeta'] === true || line['isCompactSummary'] === true) return [];

  const promptSource = str(line['promptSource']);
  const source = promptSource === 'queued' ? 'queued' : promptSource === 'system' ? 'system' : 'typed';
  return [
    {
      at,
      s: 'prompt',
      text: clip(text, 2000),
      source,
      images: (text.match(IMAGE_RE) ?? []).length,
      pasted: (text.match(PASTED_RE) ?? []).length,
    },
  ];
}

function normalizeSystem(line: Json, at: number): Signal[] {
  const subtype = str(line['subtype']) ?? '';
  switch (subtype) {
    case 'turn_duration': {
      const durationMs = num(line['durationMs']) ?? 0;
      const messageCount = num(line['messageCount']);
      return [{ at, s: 'turnEnd', durationMs, ...(messageCount !== undefined ? { messageCount } : {}) }];
    }
    case 'stop_hook_summary':
      // A stop hook that did not prevent continuation also ends the turn.
      return line['preventedContinuation'] === true
        ? [{ at, s: 'hook', ok: false }]
        : [{ at, s: 'hook', ok: line['hookErrors'] ? false : true }];
    case 'compact_boundary': {
      const meta = asObject(line['compactMetadata']);
      const durationMs = num(meta?.['durationMs']);
      return [
        {
          at,
          s: 'compact',
          trigger: str(meta?.['trigger']) ?? 'auto',
          pre: num(meta?.['preTokens']) ?? 0,
          post: num(meta?.['postTokens']) ?? 0,
          ...(durationMs !== undefined ? { durationMs } : {}),
        },
      ];
    }
    case 'away_summary':
      return [{ at, s: 'notice', level: 'info', text: clip(str(line['content']) ?? 'recap', 400), origin: 'awaySummary' }];
    case 'model_refusal_fallback':
      return [
        {
          at,
          s: 'notice',
          level: 'warning',
          text: `fell back to ${str(line['fallbackModel']) ?? 'another model'}`,
          origin: 'refusalFallback',
        },
      ];
    case 'scheduled_task_fire': {
      const taskId = str(line['taskId']) ?? 'scheduled';
      const kind = str(line['taskKind']);
      const cron = str(line['cron']);
      return [{ at, s: 'scheduledFire', taskId, ...(kind ? { kind } : {}), ...(cron ? { cron } : {}) }];
    }
    case 'informational': {
      const text = str(line['content']) ?? str(line['message']) ?? '';
      if (/Remote Control (dis)?connected/i.test(text)) {
        return [{ at, s: 'remoteChange', connected: !/disconnected/i.test(text) }];
      }
      return text ? [{ at, s: 'notice', level: 'info', text: clip(text, 300), origin: 'system' }] : [];
    }
    case 'local_command':
      return [];
    default:
      return subtype ? [{ at, s: 'unknown', kind: `system/${subtype}` }] : [];
  }
}

function normalizeAttachment(line: Json, at: number): Signal[] {
  const attachment = asObject(line['attachment']);
  const kind = str(attachment?.['type']) ?? '';
  switch (kind) {
    case 'model': {
      const identity = asObject(attachment?.['identity']);
      const modelId = str(identity?.['modelId']);
      if (!modelId) return [];
      const marketingName = str(identity?.['marketingName']);
      // The transcript's per-message model id lacks the [1m] suffix; this is the
      // only place the real context window is visible.
      return [{ at, s: 'modelAttachment', modelId, ...(marketingName ? { marketingName } : {}) }];
    }
    case 'plan_mode': {
      const planFilePath = str(attachment?.['planFilePath']);
      return [{ at, s: 'planMode', state: 'enter', ...(planFilePath ? { planFilePath } : {}) }];
    }
    case 'plan_mode_exit':
      return [{ at, s: 'planMode', state: 'exit' }];
    case 'plan_mode_reentry':
      return [{ at, s: 'planMode', state: 'reentry' }];
    case 'auto_mode':
      return [{ at, s: 'autoMode', enabled: attachment?.['enabled'] !== false }];
    case 'ultra_effort_enter':
      return [{ at, s: 'effortMode', ultra: true }];
    case 'ultra_effort_exit':
      return [{ at, s: 'effortMode', ultra: false }];
    case 'task_reminder': {
      const items = Array.isArray(attachment?.['content']) ? (attachment['content'] as unknown[]) : [];
      const parsed = items
        .map((item) => asObject(item))
        .filter((item): item is Json => !!item)
        .map((item, index) => ({
          id: str(item['id']) ?? String(index),
          subject: str(item['subject']) ?? str(item['content']) ?? '',
          ...(str(item['activeForm']) ? { activeForm: str(item['activeForm'])! } : {}),
          status: str(item['status']) ?? 'pending',
        }));
      return parsed.length ? [{ at, s: 'tasks', items: parsed }] : [];
    }
    case 'task_status': {
      // Progress on a background agent, repeated every so often while it runs:
      // `deltaSummary` is a sentence about what it is doing right now, which is
      // the freshest thing the transcript ever says about a subagent.
      const taskId = str(attachment?.['taskId']);
      if (!taskId) return [];
      const description = str(attachment?.['description']);
      const summary = str(attachment?.['deltaSummary']);
      return [
        {
          at,
          s: 'agentProgress',
          taskId,
          status: str(attachment?.['status']) ?? 'running',
          ...(description ? { description: clip(description, 200) } : {}),
          ...(summary ? { summary: clip(summary, 200) } : {}),
        },
      ];
    }
    case 'hook_success':
      return [{ at, s: 'hook', ok: true }];
    case 'hook_non_blocking_error':
      return [{ at, s: 'hook', ok: false, detail: clip(str(attachment?.['error']) ?? 'hook error', 200) }];
    case 'remote_session_change':
      return [{ at, s: 'remoteChange', connected: attachment?.['connected'] !== false }];
    case 'queued_command': {
      const prompt = str(attachment?.['prompt']) ?? '';
      const origin = asObject(attachment?.['origin']);
      const originKind = str(origin?.['kind']);
      if (originKind === 'peer') {
        return [{ at, s: 'inbound', via: 'peer', from: str(origin?.['from']) ?? '', text: clip(prompt, 1200) }];
      }
      return prompt ? [{ at, s: 'queueOp', op: 'enqueue', content: clip(prompt, 400) }] : [];
    }
    // Noise: reminders, listings and snapshots the UI never shows.
    case 'total_tokens_reminder':
    case 'environment':
    case 'batching_reminder_sent':
    case 'prompt_snapshot':
    case 'deferred_tools_delta':
    case 'deferred_tools_record':
    case 'agent_listing_delta':
    case 'skill_listing':
    case 'mcp_instructions_delta':
    case 'bash_output_audience_note':
    case 'silent_turn_reminder':
    case 'date':
    case 'date_change':
    case 'instructions':
    case 'session_context':
    case 'command_permissions':
    case 'nested_memory':
    case 'file':
    case 'edited_text_file':
    case 'hook_additional_context':
    case 'hook_system_message':
    case 'compact_file_reference':
    case 'plan_file_reference':
    case 'invoked_skills':
      return [];
    default:
      return kind ? [{ at, s: 'unknown', kind: `attachment/${kind}` }] : [];
  }
}
