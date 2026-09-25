import { describe, expect, it } from 'vitest';
import { normalizeLine, parseTaskNotification } from '@engine/parse/normalize';
import type { Signal } from '@engine/parse/signals';

const NOW = Date.parse('2026-09-19T12:00:00.000Z');
const TS = '2026-09-19T11:59:00.000Z';
const AT = Date.parse(TS);

function run(line: object): Signal[] {
  return normalizeLine(JSON.stringify(line), { now: NOW });
}

function kinds(signals: Signal[]): string[] {
  return signals.map((s) => s.s);
}

describe('normalizeLine', () => {
  it('survives garbage without throwing', () => {
    expect(normalizeLine('not json', { now: NOW })).toEqual([]);
    expect(normalizeLine('', { now: NOW })).toEqual([]);
    expect(normalizeLine('{"type":"assistant"}', { now: NOW })).toEqual([]);
  });

  it('falls back to the wall clock when a line has no timestamp', () => {
    const [signal] = run({ type: 'permission-mode', permissionMode: 'plan' });
    expect(signal?.at).toBe(NOW);
  });

  it('reads context usage as input + both cache buckets', () => {
    const signals = run({
      type: 'assistant',
      timestamp: TS,
      effort: 'xhigh',
      message: {
        id: 'msg_1',
        model: 'claude-opus-5',
        stop_reason: 'tool_use',
        content: [{ type: 'text', text: 'hello' }],
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 400_000,
          cache_creation_input_tokens: 1_000,
          output_tokens: 120,
          output_tokens_details: { thinking_tokens: 60 },
          speed: 'standard',
        },
      },
    });
    const usage = signals.find((s) => s.s === 'usage');
    expect(usage).toMatchObject({ used: 401_010, output: 120, effort: 'xhigh', model: 'claude-opus-5' });
    expect(kinds(signals)).toContain('text');
  });

  it('keeps the message id so the reducer can dedupe split responses', () => {
    // One API response is written as one line per content block, each repeating usage.
    const first = run({
      type: 'assistant',
      timestamp: TS,
      message: { id: 'msg_2', model: 'claude-opus-5', content: [{ type: 'thinking', thinking: '', signature: 'x' }], usage: { input_tokens: 5 } },
    });
    const second = run({
      type: 'assistant',
      timestamp: TS,
      message: { id: 'msg_2', model: 'claude-opus-5', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 5 } },
    });
    const ids = [...first, ...second].filter((s) => s.s === 'usage').map((s) => (s as { messageId: string }).messageId);
    expect(ids).toEqual(['msg_2', 'msg_2']);
  });

  it('marks redacted thinking as null rather than empty text', () => {
    const [, thinking] = run({
      type: 'assistant',
      timestamp: TS,
      message: { id: 'm', model: 'claude-opus-5', usage: { input_tokens: 1 }, content: [{ type: 'thinking', thinking: '', signature: 'sig' }] },
    });
    expect(thinking).toMatchObject({ s: 'thinking', text: null });
  });

  it('emits tool calls and their results', () => {
    const [, tool] = run({
      type: 'assistant',
      timestamp: TS,
      message: {
        id: 'm3',
        model: 'claude-opus-5',
        usage: { input_tokens: 1 },
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }],
      },
    });
    expect(tool).toMatchObject({ s: 'toolUse', id: 'toolu_1', name: 'Bash' });

    const [result] = run({
      type: 'user',
      timestamp: TS,
      toolUseResult: { stdout: 'ok', stderr: '' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    });
    expect(result).toMatchObject({ s: 'toolResult', id: 'toolu_1', isError: false, text: 'ok' });
  });

  it('treats a denied tool as an error and keeps the denial kind', () => {
    const [result] = run({
      type: 'user',
      timestamp: TS,
      toolDenialKind: 'user-rejected',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'no' }] },
    });
    expect(result).toMatchObject({ s: 'toolResult', isError: true, denial: 'user-rejected' });
  });

  it('recognises a typed prompt, with image and paste markers', () => {
    const [prompt] = run({
      type: 'user',
      timestamp: TS,
      promptSource: 'typed',
      origin: { kind: 'human' },
      message: { content: 'look at [Image #1] and [Pasted text #1 +40 lines]' },
    });
    expect(prompt).toMatchObject({ s: 'prompt', source: 'typed', images: 1, pasted: 1 });
  });

  it('detects an interrupt instead of reading it as a prompt', () => {
    const [signal] = run({
      type: 'user',
      timestamp: TS,
      message: { content: '[Request interrupted by user for tool use]' },
    });
    expect(signal).toMatchObject({ s: 'interrupt', forTool: true });
  });

  it('parses the task-notification envelope shared by agents, background bash and monitors', () => {
    const text = [
      '<task-notification><task-id>a1234567890abcdef</task-id>',
      '<tool-use-id>toolu_9</tool-use-id><status>completed</status>',
      '<summary>Agent "x" finished</summary><result>all done</result>',
      '<usage><subagent_tokens>176364</subagent_tokens><tool_uses>43</tool_uses><duration_ms>369480</duration_ms></usage>',
      '</task-notification>',
    ].join('');
    const notification = parseTaskNotification(text);
    expect(notification).toMatchObject({
      taskId: 'a1234567890abcdef',
      toolUseId: 'toolu_9',
      status: 'completed',
      tokens: 176364,
      toolUses: 43,
      durationMs: 369480,
    });

    const [signal] = run({ type: 'user', timestamp: TS, origin: { kind: 'task-notification' }, message: { content: text } });
    expect(signal?.s).toBe('taskNotification');

    // The same envelope also arrives as a queue-operation; both must parse.
    const [queued] = run({ type: 'queue-operation', timestamp: TS, operation: 'enqueue', content: text });
    expect(queued?.s).toBe('taskNotification');
  });

  it('reads compaction, turn end and scheduled fires from system lines', () => {
    const [compact] = run({
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: TS,
      compactMetadata: { trigger: 'manual', preTokens: 700_000, postTokens: 120_000, durationMs: 9000 },
    });
    expect(compact).toMatchObject({ s: 'compact', trigger: 'manual', pre: 700_000, post: 120_000 });

    const [turn] = run({ type: 'system', subtype: 'turn_duration', timestamp: TS, durationMs: 23_000, messageCount: 4 });
    expect(turn).toMatchObject({ s: 'turnEnd', durationMs: 23_000 });

    const [fire] = run({ type: 'system', subtype: 'scheduled_task_fire', timestamp: TS, taskId: 'bg1', taskKind: 'loop' });
    expect(fire).toMatchObject({ s: 'scheduledFire', taskId: 'bg1', kind: 'loop' });
  });

  it('takes the real context window from the model attachment, not the message model', () => {
    const [signal] = run({
      type: 'attachment',
      timestamp: TS,
      attachment: { type: 'model', identity: { modelId: 'claude-opus-5[1m]', marketingName: 'Opus 5 (1M context)' } },
    });
    expect(signal).toMatchObject({ s: 'modelAttachment', modelId: 'claude-opus-5[1m]' });
  });

  it('routes message deliveries by origin', () => {
    const [coordinator] = run({
      type: 'user',
      timestamp: TS,
      isMeta: true,
      origin: { kind: 'coordinator' },
      message: { content: 'The coordinator sent a message while you were working:\nkeep going' },
    });
    expect(coordinator).toMatchObject({ s: 'inbound', via: 'coordinator' });

    const [cross] = run({
      type: 'user',
      timestamp: TS,
      origin: { kind: 'peer' },
      message: { content: '<cross-session-message from="atrium-visual-companion">ping</cross-session-message>' },
    });
    expect(cross).toMatchObject({ s: 'inbound', via: 'crossSession', from: 'atrium-visual-companion' });
  });

  it('ignores bookkeeping lines and reports genuinely unknown ones', () => {
    expect(run({ type: 'file-history-snapshot', timestamp: TS })).toEqual([]);
    expect(run({ type: 'artifact-autoreact-ledger', timestamp: TS })).toEqual([]);
    expect(run({ type: 'attachment', timestamp: TS, attachment: { type: 'total_tokens_reminder' } })).toEqual([]);

    const [unknown] = run({ type: 'brand-new-line-type', timestamp: TS });
    expect(unknown).toMatchObject({ s: 'unknown', kind: 'brand-new-line-type' });
  });
});

describe('background agent progress', () => {
  it('reads the live progress ping Claude Code drops while an agent runs', () => {
    const signals = normalizeLine(
      JSON.stringify({
        type: 'attachment',
        timestamp: '2026-09-19T21:55:56.241Z',
        attachment: {
          type: 'task_status',
          taskId: 'a3787c34066b43c71',
          taskType: 'local_agent',
          description: 'Exp m-0 regime R0',
          status: 'running',
          deltaSummary: 'Reading UIntMath and SignatureChecker libs',
          outputFilePath: '/tmp/tasks/a3787c34066b43c71.output',
        },
      }),
      { now: 0 },
    );

    expect(signals).toHaveLength(1);
    const signal = signals[0]!;
    expect(signal.s).toBe('agentProgress');
    if (signal.s !== 'agentProgress') throw new Error('wrong signal');
    expect(signal.taskId).toBe('a3787c34066b43c71');
    expect(signal.status).toBe('running');
    expect(signal.summary).toBe('Reading UIntMath and SignatureChecker libs');
    expect(signal.description).toBe('Exp m-0 regime R0');
  });

  it('ignores a ping with no task to attach it to', () => {
    expect(
      normalizeLine(
        JSON.stringify({ type: 'attachment', attachment: { type: 'task_status', status: 'running' } }),
        { now: 0 },
      ),
    ).toEqual([]);
  });
});
