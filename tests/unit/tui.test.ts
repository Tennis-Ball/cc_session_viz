import { describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '@shared/transcript';
import { formatEntry, type TuiContext, type TuiLine } from '../../src/renderer/canvas/tui/formatEntry';
import { markdownLite, mdInline } from '../../src/renderer/canvas/tui/markdownLite';
import { cells, wrapSpans } from '../../src/renderer/canvas/tui/wrap';

const AT = Date.parse('2026-09-19T17:17:00.000Z');
const CTX: TuiContext = { cols: 60, cwd: '/Users/choim/code/atrium' };

/** What a reader would see: one string per rendered row. */
function render(lines: TuiLine[]): string[] {
  return lines.map((line) => line.spans.map((s) => s.text).join(''));
}

function classes(line: TuiLine | undefined): (string | undefined)[] {
  return (line?.spans ?? []).map((s) => s.cls);
}

type Tool = Extract<TranscriptEntry, { k: 'tool' }>;

function tool(patch: Partial<Tool>): Tool {
  return {
    k: 'tool',
    id: 'tu_1',
    at: AT,
    name: 'Bash',
    title: 'Bash',
    arg: '',
    status: 'ok',
    ...patch,
  };
}

function user(patch: Partial<Extract<TranscriptEntry, { k: 'user' }>>): TranscriptEntry {
  return { k: 'user', id: 'u1', at: AT, text: '', source: 'typed', images: 0, pasted: 0, ...patch };
}

describe('user entries', () => {
  it('draws the prompt as a full-width band', () => {
    const lines = formatEntry(user({ text: 'wire up canvas mode' }), CTX);
    expect(render(lines)).toEqual(['> wire up canvas mode']);
    expect(lines[0]?.band).toBe('user');
  });

  it('indents wrapped prompt text by two and keeps the band', () => {
    const text = 'reconstruct the Claude Code TUI from the transcript entries';
    const lines = formatEntry(user({ text }), { cols: 24 });
    const out = render(lines);
    expect(out[0]).toBe('> reconstruct the Claude');
    expect(out.slice(1).every((line) => line.startsWith('  '))).toBe(true);
    expect(out.every((line) => cells(line) <= 24)).toBe(true);
    expect(out.join(' ').replace(/[>\s]+/g, ' ').trim()).toBe(text);
    expect(lines.every((line) => line.band === 'user')).toBe(true);
  });

  it('dims the composer markers that trail a prompt', () => {
    const lines = formatEntry(user({ text: 'look at this', images: 1, pasted: 1 }), CTX);
    expect(render(lines)[0]).toBe('> look at this [Image #1] [Pasted text #1]');
    const last = lines[0]?.spans[lines[0].spans.length - 1];
    expect(last?.cls).toBe('dim');
    expect(last?.text).toBe(' [Image #1] [Pasted text #1]');
  });

  it('keeps a multi-line prompt on its own rows', () => {
    expect(render(formatEntry(user({ text: 'first\nsecond' }), CTX))).toEqual(['> first', '  second']);
  });

  it('survives an empty prompt', () => {
    expect(render(formatEntry(user({ text: '' }), CTX))).toEqual(['>']);
  });
});

describe('assistant text', () => {
  const text = (body: string): TranscriptEntry => ({ k: 'text', id: 'a1', at: AT, text: body });

  it('bullets the first line and indents the rest', () => {
    const out = render(formatEntry(text('Done.\nTwo files changed.'), CTX));
    expect(out).toEqual(['● Done.', '  Two files changed.']);
  });

  it('styles bold and code through markdownLite', () => {
    const lines = formatEntry(text('ran **all** the `vitest` specs'), CTX);
    expect(render(lines)[0]).toBe('● ran all the vitest specs');
    expect(classes(lines[0])).toEqual(['bullet', undefined, 'bold', undefined, 'code', undefined]);
  });

  it('renders list bullets as •', () => {
    expect(render(formatEntry(text('- one\n- two'), CTX))).toEqual(['● • one', '  • two']);
  });

  it('emits nothing for an empty message', () => {
    expect(formatEntry(text('   '), CTX)).toEqual([]);
  });
});

describe('thinking', () => {
  it('shows the ellipsis header and the thought below it', () => {
    const entry: TranscriptEntry = { k: 'thinking', id: 'k1', at: AT, text: 'check the wrap indent' };
    const lines = formatEntry(entry, CTX);
    expect(render(lines)).toEqual(['✻ Thinking…', '  check the wrap indent']);
    expect(classes(lines[1])).toContain('thinking');
  });

  it('falls back to a token count when the thought is redacted', () => {
    const entry: TranscriptEntry = { k: 'thinking', id: 'k2', at: AT, text: null, tokens: 12_400 };
    expect(render(formatEntry(entry, CTX))).toEqual(['✻ Thinking… (12.4k tokens)']);
  });
});

describe('tool calls', () => {
  it('shows three lines of Bash output and counts the rest', () => {
    const entry = tool({
      name: 'Bash',
      arg: 'npx vitest run tests/unit',
      result: { head: ['RUN v3.2.4', '', '✓ tests/unit/tui.test.ts', 'x', 'y', 'z'], totalLines: 40 },
    });
    expect(render(formatEntry(entry, CTX))).toEqual([
      '● Bash(npx vitest run tests/unit)',
      '  ⎿  RUN v3.2.4',
      '', // a blank output line stays blank rather than carrying five spaces
      '     ✓ tests/unit/tui.test.ts',
      '     … +37 lines (ctrl+o to expand)',
    ]);
  });

  it('paints an ok bullet green-ish and a failed one red', () => {
    const ok = formatEntry(tool({ result: { head: ['fine'], totalLines: 1 } }), CTX);
    expect(classes(ok[0])?.[0]).toBe('bullet-tool');

    const bad = formatEntry(
      tool({ status: 'error', arg: 'npm run typecheck', result: { head: ['error TS2345'], totalLines: 1 } }),
      CTX,
    );
    expect(classes(bad[0])?.[0]).toBe('bullet-error');
    expect(render(bad)[1]).toBe('  ⎿  error TS2345');
    expect(classes(bad[1])).toContain('notice-error');
  });

  it('shows a failure message rather than the usual summary line', () => {
    const entry = tool({
      name: 'Grep',
      title: 'Grep',
      arg: '(unclosed',
      status: 'error',
      result: { head: ['rg: regex parse error', 'unclosed group'], totalLines: 2 },
    });
    expect(render(formatEntry(entry, CTX))).toEqual([
      '● Grep((unclosed)',
      '  ⎿  rg: regex parse error',
      '     unclosed group',
    ]);
  });

  it('says what a denied call would have done', () => {
    const lines = formatEntry(tool({ status: 'denied', arg: 'rm -rf /' }), CTX);
    expect(render(lines)).toEqual([
      '● Bash(rm -rf /)',
      '  ⎿  No (tell Claude what to do differently)',
    ]);
  });

  it('leaves a pending call bare and dim', () => {
    const lines = formatEntry(tool({ status: 'pending', arg: 'npm run build' }), CTX);
    expect(render(lines)).toEqual(['● Bash(npm run build)']);
    expect(classes(lines[0])?.[0]).toBe('dim');
  });

  it('reads empty output as (no content)', () => {
    const entry = tool({ arg: 'touch out.txt', result: { head: [], totalLines: 0 } });
    expect(render(formatEntry(entry, CTX))).toEqual(['● Bash(touch out.txt)', '  ⎿  (no content)']);
  });

  it('truncates a long command so the header stays on one line', () => {
    const entry = tool({ arg: 'git log --oneline --graph --decorate --all --since=2026-01-01' });
    const out = render(formatEntry(entry, { cols: 30 }));
    expect(out).toHaveLength(1);
    expect(out[0]).toBe('● Bash(git log --oneline --g…)');
    expect(cells(out[0] ?? '')).toBeLessThanOrEqual(30);
  });

  it('names the file and the line count for Read', () => {
    const entry = tool({
      name: 'Read',
      title: 'Read',
      arg: '/Users/choim/code/atrium/src/renderer/canvas/tui/wrap.ts',
      result: { head: ['     1\timport…'], totalLines: 128 },
    });
    expect(render(formatEntry(entry, CTX))).toEqual(['● Read(wrap.ts)', '  ⎿  Read 128 lines']);
  });

  it('counts an edit in additions and removals, with the hunk under it', () => {
    const entry = tool({
      name: 'Edit',
      title: 'Edit',
      arg: '/Users/choim/code/atrium/src/renderer/canvas/tui/wrap.ts',
      result: { head: [], totalLines: 1 },
      diff: { added: 3, removed: 1, hunk: ['-const a = 1;', '+const a = 2;', '+const b = 3;', '+const c = 4;', '+const d = 5;'] },
    });
    const out = render(formatEntry(entry, CTX));
    expect(out[0]).toBe('● Update(wrap.ts)');
    expect(out[1]).toBe('  ⎿  Updated wrap.ts with 3 additions and 1 removal');
    expect(out.slice(2)).toEqual([
      '     -const a = 1;',
      '     +const a = 2;',
      '     +const b = 3;',
      '     +const c = 4;',
    ]);
  });

  it('gets addition/removal plurals right', () => {
    const one = tool({
      name: 'Edit',
      arg: 'notes.md',
      result: { head: [], totalLines: 1 },
      diff: { added: 1, removed: 0 },
    });
    expect(render(formatEntry(one, CTX))[1]).toBe('  ⎿  Updated notes.md with 1 addition');

    const two = tool({
      name: 'Write',
      arg: 'notes.md',
      result: { head: [], totalLines: 1 },
      diff: { added: 0, removed: 2 },
    });
    const out = render(formatEntry(two, CTX));
    expect(out[0]).toBe('● Write(notes.md)');
    expect(out[1]).toBe('  ⎿  Updated notes.md with 2 removals');
  });

  it('counts matches and files for the search tools', () => {
    const grep = tool({ name: 'Grep', title: 'Grep', arg: 'TuiSpan', result: { head: [], totalLines: 12 } });
    expect(render(formatEntry(grep, CTX))[1]).toBe('  ⎿  Found 12 matches');

    const glob = tool({ name: 'Glob', title: 'Glob', arg: '**/*.tsx', result: { head: [], totalLines: 1 } });
    expect(render(formatEntry(glob, CTX))[1]).toBe('  ⎿  Found 1 file');
  });

  it('reports a finished Agent the way the TUI does', () => {
    const verbatim = tool({
      name: 'Agent',
      title: 'Agent',
      arg: 'sweep the renderer for dead code',
      result: { head: [], totalLines: 1, summary: 'Done (7 tool uses · 45.2k tokens · 12s)' },
    });
    expect(render(formatEntry(verbatim, CTX))).toEqual([
      '● Agent(sweep the renderer for dead code)',
      '  ⎿  Done (7 tool uses · 45.2k tokens · 12s)',
    ]);

    const rebuilt = tool({
      name: 'Task',
      arg: 'sweep',
      result: { head: [], totalLines: 1, summary: '7 tool uses, 45200 tokens, 12000ms' },
    });
    expect(render(formatEntry(rebuilt, CTX))[1]).toBe('  ⎿  Done (7 tool uses · 45.2k tokens · 12s)');
  });

  it('points a Workflow at the runs view', () => {
    const entry = tool({ name: 'Workflow', title: 'Workflow', arg: 'release', result: { head: [], totalLines: 1 } });
    expect(render(formatEntry(entry, CTX))).toEqual([
      '● Workflow(release)',
      '  ⎿  /workflows to view dynamic workflow runs',
    ]);
  });

  it('shows the host for a fetch and the query for a search', () => {
    const fetched = tool({
      name: 'WebFetch',
      arg: 'https://docs.claude.com/en/docs/claude-code/hooks',
      result: { head: [], totalLines: 34 },
    });
    expect(render(formatEntry(fetched, CTX))).toEqual([
      '● WebFetch(docs.claude.com)',
      '  ⎿  Received 34 lines',
    ]);

    const searched = tool({ name: 'WebSearch', arg: 'electron vite alias', result: { head: [], totalLines: 8 } });
    expect(render(formatEntry(searched, CTX))[0]).toBe('● WebSearch("electron vite alias")');
  });

  it('renders a todo list as checkboxes', () => {
    const entry = tool({
      name: 'TodoWrite',
      title: 'TodoWrite',
      result: { head: ['[x] Read the transcript types', '[ ] Write the wrapper', '☒ Ship it'], totalLines: 3 },
    });
    const lines = formatEntry(entry, CTX);
    expect(render(lines)).toEqual([
      '● TodoWrite',
      '  ⎿  ☒ Read the transcript types',
      '     ☐ Write the wrapper',
      '     ☒ Ship it',
    ]);
    expect(classes(lines[1])).toContain('task-done');
    expect(classes(lines[2])).toContain('task-open');
  });

  it('falls back to a generic header and head lines for unknown tools', () => {
    const entry = tool({
      name: 'Monitor',
      title: 'Monitor',
      arg: 'until the build settles',
      result: { head: ['watching', 'still watching'], totalLines: 2 },
    });
    expect(render(formatEntry(entry, CTX))).toEqual([
      '● Monitor(until the build settles)',
      '  ⎿  watching',
      '     still watching',
    ]);
  });

  it('splits an MCP tool into server and tool', () => {
    const entry = tool({
      name: 'mcp__claude_ai_Claude_Docs__batch',
      title: 'mcp__claude_ai_Claude_Docs__batch',
      arg: 'notes',
      result: { head: ['ok'], totalLines: 1 },
    });
    expect(render(formatEntry(entry, CTX))[0]).toBe('● claude_ai_Claude_Docs · batch(notes)');
  });

  it('wraps a long result line under the elbow', () => {
    const entry = tool({
      arg: 'cat note',
      result: { head: ['the quick brown fox jumps over the lazy dog again and again'], totalLines: 1 },
    });
    const out = render(formatEntry(entry, { cols: 28 }));
    expect(out[1]?.startsWith('  ⎿  ')).toBe(true);
    expect(out.slice(2).every((line) => line.startsWith('     '))).toBe(true);
    expect(out.every((line) => cells(line) <= 28)).toBe(true);
  });
});

describe('session lines', () => {
  it('closes a turn with the verb, duration and clock', () => {
    const entry: TranscriptEntry = { k: 'turnEnd', id: 'e1', at: AT, durationMs: 23_000, verbSeed: 10 };
    const out = render(formatEntry(entry, CTX));
    expect(out[0]).toMatch(/^✻ Ruminated for 23s · done \d{1,2}:\d{2}\s?[AP]M$/);
  });

  it('notes a compaction with both token counts', () => {
    const entry: TranscriptEntry = { k: 'compact', id: 'c1', at: AT, trigger: 'auto', pre: 700_000, post: 120_000 };
    expect(render(formatEntry(entry, CTX))).toEqual(['✻ Conversation compacted · 700k → 120k tokens']);
  });

  it('hangs a tool interrupt off the call above it', () => {
    const forTool: TranscriptEntry = { k: 'interrupt', id: 'i1', at: AT, forTool: true };
    const lines = formatEntry(forTool, CTX);
    expect(render(lines)).toEqual(['  ⎿  Interrupted · What should Claude do instead?']);
    expect(classes(lines[0])).toContain('notice-error');

    const bare: TranscriptEntry = { k: 'interrupt', id: 'i2', at: AT, forTool: false };
    expect(render(formatEntry(bare, CTX))).toEqual(['⎿  Interrupted · What should Claude do instead?']);
  });

  it('colours a notice by level', () => {
    const levels = (['info', 'warning', 'error'] as const).map((level) =>
      formatEntry({ k: 'notice', id: `s${level}`, at: AT, level, text: 'hook blocked the edit', origin: 'hook' }, CTX),
    );
    expect(render(levels[0] ?? [])).toEqual(['※ hook blocked the edit']);
    expect(classes(levels[0]?.[0])?.[0]).toBe('notice');
    expect(classes(levels[1]?.[0])?.[0]).toBe('notice-warn');
    expect(classes(levels[2]?.[0])?.[0]).toBe('notice-error');
  });

  it('bolds who an inbound message came from', () => {
    const entry: TranscriptEntry = {
      k: 'inbound',
      id: 'n1',
      at: AT,
      from: 'Explore',
      via: 'task',
      text: 'found three call sites',
    };
    const lines = formatEntry(entry, CTX);
    expect(render(lines)).toEqual(['⎿  Explore found three call sites']);
    expect(classes(lines[0])).toEqual(['dim', 'bold', 'inbound']);
  });

  it('centres a divider on a full-width rule', () => {
    const entry: TranscriptEntry = { k: 'divider', id: 'd1', at: AT, reason: 'clear', sessionId: 's' };
    const out = render(formatEntry(entry, { cols: 40 }));
    expect(cells(out[0] ?? '')).toBe(40);
    expect(out[0]).toBe(`${'─'.repeat(16)} /clear ${'─'.repeat(16)}`);
  });
});

describe('wrapSpans', () => {
  it('hard-breaks a token with nowhere to break', () => {
    const path = '/Users/choim/code/personal_projects/cc_session_viz/src/renderer/canvas/tui/wrap.ts';
    const lines = wrapSpans([{ text: path, cls: 'code' }], 20, 2);
    const out = lines.map((line) => line.map((s) => s.text).join(''));
    expect(out.every((line) => cells(line) <= 20)).toBe(true);
    expect(out.length).toBeGreaterThan(3);
    expect(out.slice(1).every((line) => line.startsWith('  '))).toBe(true);
    expect(out.map((line, i) => (i === 0 ? line : line.slice(2))).join('')).toBe(path);
  });

  it('keeps span classes across a break', () => {
    const lines = wrapSpans(
      [
        { text: 'alpha beta ', cls: 'bold' },
        { text: 'gamma delta', cls: 'code' },
      ],
      12,
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]?.map((s) => s.cls)).toEqual(['bold']);
    expect(lines[1]?.map((s) => s.cls)).toEqual(['code']);
    expect(lines.map((l) => l.map((s) => s.text).join(''))).toEqual(['alpha beta', 'gamma delta']);
  });

  it('degrades to a single line rather than looping on cols <= 0', () => {
    expect(wrapSpans([{ text: 'one two three' }], 0, 2)).toEqual([[{ text: 'one two three' }]]);
    expect(wrapSpans([{ text: 'one two three' }], -8)).toHaveLength(1);
    expect(wrapSpans([], 40)).toEqual([[]]);
  });

  it('keeps the indent the caller passed in on the first line', () => {
    const lines = wrapSpans([{ text: '    indented and quite long here' }], 16, 4);
    const out = lines.map((line) => line.map((s) => s.text).join(''));
    expect(out[0]?.startsWith('    ')).toBe(true);
    expect(out.every((line) => cells(line) <= 16)).toBe(true);
  });
});

describe('markdownLite', () => {
  it('bolds headings and keeps fences verbatim and dim', () => {
    const lines = markdownLite('## Plan\n```ts\n  const a = 1;\n```');
    expect(lines[0]).toEqual([{ text: 'Plan', cls: 'bold' }]);
    expect(lines[1]).toEqual([{ text: '```ts', cls: 'dim' }]);
    expect(lines[2]).toEqual([{ text: '  const a = 1;', cls: 'dim' }]);
    expect(lines[3]).toEqual([{ text: '```', cls: 'dim' }]);
  });

  it('does not parse markdown inside a fence', () => {
    const lines = markdownLite('```\n**not bold** and `not code`\n```');
    expect(lines[1]).toEqual([{ text: '**not bold** and `not code`', cls: 'dim' }]);
  });

  it('leaves mid-word asterisks and stray backticks alone', () => {
    expect(mdInline('2*3*4 is twelve')).toEqual([{ text: '2*3*4 is twelve' }]);
    expect(mdInline('a stray ` backtick')).toEqual([{ text: 'a stray ` backtick' }]);
    expect(mdInline('snake_case_name')).toEqual([{ text: 'snake_case_name' }]);
  });

  it('never throws on malformed markdown', () => {
    for (const bad of ['**', '***', '`', '``', '*a**b*', '# ', '- ', '```', '*', '**a`b*']) {
      expect(() => markdownLite(bad)).not.toThrow();
    }
  });

  it('renders italics bold-ish', () => {
    expect(mdInline('an *emphatic* word')).toEqual([
      { text: 'an ' },
      { text: 'emphatic', cls: 'bold' },
      { text: ' word' },
    ]);
  });
});

describe('formatEntry contract', () => {
  it('gives every line a unique key and is stable across calls', () => {
    const entry = tool({
      arg: 'npm test',
      result: { head: ['a', 'b', 'c', 'd'], totalLines: 9 },
    });
    const first = formatEntry(entry, CTX);
    const second = formatEntry(entry, CTX);
    expect(second).toEqual(first);
    expect(new Set(first.map((line) => line.key)).size).toBe(first.length);
    expect(first[0]?.key).toBe('tu_1#0');
  });

  it('renders every entry kind without throwing at cols 0', () => {
    const entries: TranscriptEntry[] = [
      user({ text: 'hi' }),
      { k: 'text', id: 't', at: AT, text: 'hello' },
      { k: 'thinking', id: 'k', at: AT, text: null },
      tool({ id: 'x', result: { head: ['out'], totalLines: 1 } }),
      { k: 'turnEnd', id: 'e', at: AT, durationMs: 1000, verbSeed: 3 },
      { k: 'compact', id: 'c', at: AT, trigger: 'auto', pre: 1, post: 1 },
      { k: 'interrupt', id: 'i', at: AT, forTool: true },
      { k: 'notice', id: 's', at: AT, level: 'info', text: 'note', origin: 'system' },
      { k: 'inbound', id: 'n', at: AT, from: 'peer', via: 'peer', text: 'ping' },
      { k: 'divider', id: 'd', at: AT, reason: 'resume', sessionId: 's' },
    ];
    for (const entry of entries) {
      expect(() => formatEntry(entry, { cols: 0 })).not.toThrow();
      expect(formatEntry(entry, { cols: 0 }).length).toBeGreaterThan(0);
    }
  });

  it('handles a tool entry with no result at all', () => {
    expect(render(formatEntry(tool({ arg: 'ls' }), CTX))).toEqual(['● Bash(ls)']);
  });
});
