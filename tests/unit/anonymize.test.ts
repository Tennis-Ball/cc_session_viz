/**
 * Round-trip properties of the fixture anonymizer.
 *
 * The whole point of `fixtures/` is that the engine can be tested against real
 * transcript *shapes*, so these tests assert the shape survives: same keys, same
 * enum values, same usage numbers, same id shapes, same structural markers —
 * while the human-readable content is gone and the result is reproducible.
 *
 * The sample lines below are hand-written to match the shapes that
 * `scripts/schema-drift.ts` actually reports from `~/.claude`.
 */

import { describe, expect, it } from 'vitest';
import { anonymizeLine, pseudoText, remapId, looksLikeSecret } from '../../scripts/record-fixture';

const SEED = 1337;

// ---------------------------------------------------------------------------
// sample lines
// ---------------------------------------------------------------------------

const ASSISTANT_LINE = JSON.stringify({
  parentUuid: 'bde2f3d1-32bc-413a-9020-0458bb89a787',
  isSidechain: false,
  userType: 'external',
  cwd: '/Users/realname/code/secret-repo/packages/api',
  sessionId: 'cd4067b7-7849-497e-8f58-160c9a525bcd',
  version: '2.1.259',
  gitBranch: 'main',
  slug: 'a3bc046734e67fd4c',
  effort: 'xhigh',
  message: {
    id: 'msg_011HfznUoSIMrLquay2FdVZ4',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [
      { type: 'thinking', thinking: 'The customer database migration is behind schedule.', signature: 'EqQBCkYIBxgCKkDq' },
      { type: 'text', text: 'I will rename the AcmeCorp billing table.' },
      {
        type: 'tool_use',
        id: 'toolu_01TAzd2V7rKIAt7CXJmwFwm2',
        name: 'Bash',
        input: { command: 'psql -c "select * from acme_customers"', description: 'Query the customer table', timeout: 120000 },
      },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 36206,
      cache_read_input_tokens: 148231,
      output_tokens: 307,
      service_tier: 'standard',
      speed: 'standard',
      cache_creation: { ephemeral_1h_input_tokens: 36206, ephemeral_5m_input_tokens: 0 },
    },
  },
  requestId: 'req_015DtzyXy7v6CaMGmUzrseIQ',
  type: 'assistant',
  uuid: '4cbc69b5-c64b-493d-a7b2-d2cc477e2193',
  timestamp: '2026-08-06T14:11:15.769Z',
});

const TOOL_RESULT_LINE = JSON.stringify({
  parentUuid: '4cbc69b5-c64b-493d-a7b2-d2cc477e2193',
  type: 'user',
  permissionMode: 'auto',
  toolDenialKind: 'user-rejected',
  message: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_01TAzd2V7rKIAt7CXJmwFwm2', is_error: false, content: 'acme_customers\nacme_invoices\n' },
    ],
  },
  toolUseResult: {
    stdout: 'acme_customers\nacme_invoices\n',
    stderr: '',
    interrupted: false,
    isImage: false,
    filePath: '/Users/realname/code/secret-repo/src/billing.ts',
  },
  uuid: '6ce4fff8-1cd2-47a9-b006-3b1c8c2f9a41',
  timestamp: '2026-08-06T14:11:19.002Z',
});

const TASK_NOTIFICATION_LINE = JSON.stringify({
  type: 'user',
  origin: { kind: 'task-notification' },
  sessionId: 'cd4067b7-7849-497e-8f58-160c9a525bcd',
  message: {
    role: 'user',
    content: [
      {
        type: 'text',
        text:
          '<task-notification>\n' +
          '<task-id>a613c14459697b0d2</task-id>\n' +
          '<tool-use-id>toolu_014ZGaWPXVcvbdc6xBEe4TEe</tool-use-id>\n' +
          '<output-file>/Users/realname/.claude/projects/-Users-realname-code-secret/tasks/a613c14459697b0d2.output</output-file>\n' +
          '<status>completed</status>\n' +
          '<summary>Agent "Audit the AcmeCorp payment flow" finished with three findings.</summary>\n' +
          '</task-notification>',
      },
    ],
  },
  uuid: '727bbbe5-6f33-4698-9d8a-7b0c11de4a52',
  timestamp: '2026-08-06T14:12:00.000Z',
});

const COMPACT_BOUNDARY_LINE = JSON.stringify({
  type: 'system',
  subtype: 'compact_boundary',
  compactMetadata: { trigger: 'auto', preTokens: 174233, postTokens: 21044 },
  isMeta: true,
  uuid: '3d2cd0ab-2c0c-4c69-ba52-eb9f0d7c1b33',
  timestamp: '2026-08-06T15:00:00.000Z',
  sessionId: 'cd4067b7-7849-497e-8f58-160c9a525bcd',
});

const AGENT_SPAWN_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    model: 'claude-opus-5',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_01E8XpXdEy7S9vPhMzFdGRnT',
        name: 'Agent',
        input: {
          description: 'Audit the payment flow',
          prompt: 'Read AcmeCorp/billing and report every unchecked refund path.',
          subagent_type: 'Explore',
          model: 'sonnet',
        },
      },
    ],
    usage: { input_tokens: 11, output_tokens: 92 },
  },
  uuid: 'bff74047-d144-4607-9834-99aa17cd0e15',
  timestamp: '2026-08-06T14:10:00.000Z',
});

const SUBAGENT_META_LINE = JSON.stringify({
  agentType: 'Explore',
  description: 'Research the AcmeCorp refund ledger',
  toolUseId: 'toolu_01CxwnM659Vi7gUKhvutsxVM',
  spawnDepth: 1,
  requestShape: 'background',
  requestNonInteractive: true,
  model: 'opus',
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function parse(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

/** Every key path in the document, so two documents can be compared key-for-key. */
function keyPaths(node: unknown, prefix = ''): string[] {
  if (Array.isArray(node)) return node.flatMap((item, i) => keyPaths(item, `${prefix}[${i}]`));
  if (node && typeof node === 'object') {
    return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => {
      const path = prefix ? `${prefix}.${k}` : k;
      return [path, ...keyPaths(v, path)];
    });
  }
  return [];
}

/** Every non-string leaf, so numbers, booleans and nulls can be compared. */
function nonStringLeaves(node: unknown, prefix = ''): [string, unknown][] {
  if (Array.isArray(node)) return node.flatMap((item, i) => nonStringLeaves(item, `${prefix}[${i}]`));
  if (node && typeof node === 'object') {
    return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
      nonStringLeaves(v, prefix ? `${prefix}.${k}` : k),
    );
  }
  if (typeof node === 'string') return [];
  return [[prefix, node]];
}

function at(doc: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => {
    const m = /^(.*?)\[(\d+)\]$/.exec(part);
    if (m) return ((node as Record<string, unknown>)[m[1] as string] as unknown[])[Number(m[2])];
    return (node as Record<string, unknown>)[part];
  }, doc);
}

const ALL_SAMPLES = [
  ASSISTANT_LINE,
  TOOL_RESULT_LINE,
  TASK_NOTIFICATION_LINE,
  COMPACT_BOUNDARY_LINE,
  AGENT_SPAWN_LINE,
  SUBAGENT_META_LINE,
];

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('anonymizeLine: structure survives', () => {
  it('leaves every line valid JSON', () => {
    for (const line of ALL_SAMPLES) {
      expect(() => JSON.parse(anonymizeLine(line, SEED))).not.toThrow();
    }
  });

  it('keeps the key set identical, key for key', () => {
    for (const line of ALL_SAMPLES) {
      expect(keyPaths(parse(anonymizeLine(line, SEED)))).toEqual(keyPaths(parse(line)));
    }
  });

  it('keeps every number, boolean and null exactly as it was', () => {
    for (const line of ALL_SAMPLES) {
      expect(nonStringLeaves(parse(anonymizeLine(line, SEED)))).toEqual(nonStringLeaves(parse(line)));
    }
  });

  it('preserves usage numbers on an assistant line', () => {
    const out = parse(anonymizeLine(ASSISTANT_LINE, SEED));
    expect(at(out, 'message.usage')).toEqual(at(parse(ASSISTANT_LINE), 'message.usage'));
  });

  it('preserves line type, subtype, tool name, model and enum fields', () => {
    const before = parse(ASSISTANT_LINE);
    const after = parse(anonymizeLine(ASSISTANT_LINE, SEED));
    for (const path of [
      'type',
      'userType',
      'version',
      'effort',
      'timestamp',
      'message.type',
      'message.role',
      'message.model',
      'message.stop_reason',
      'message.content[0].type',
      'message.content[1].type',
      'message.content[2].type',
      'message.content[2].name',
    ]) {
      expect(at(after, path), path).toEqual(at(before, path));
    }

    const compact = parse(anonymizeLine(COMPACT_BOUNDARY_LINE, SEED));
    expect(compact['type']).toBe('system');
    expect(compact['subtype']).toBe('compact_boundary');
    expect(at(compact, 'compactMetadata.trigger')).toBe('auto');

    const denial = parse(anonymizeLine(TOOL_RESULT_LINE, SEED));
    expect(denial['permissionMode']).toBe('auto');
    expect(denial['toolDenialKind']).toBe('user-rejected');
    expect(at(denial, 'message.content[0].type')).toBe('tool_result');

    const spawn = parse(anonymizeLine(AGENT_SPAWN_LINE, SEED));
    expect(at(spawn, 'message.content[0].name')).toBe('Agent');
    expect(at(spawn, 'message.content[0].input.subagent_type')).toBe('Explore');
    expect(at(spawn, 'message.content[0].input.model')).toBe('sonnet');

    const meta = parse(anonymizeLine(SUBAGENT_META_LINE, SEED));
    expect(meta['agentType']).toBe('Explore');
    expect(meta['requestShape']).toBe('background');
    expect(meta['model']).toBe('opus');
  });

  it('keeps an unqualified agent type but strips the org from a plugin-qualified one', () => {
    const line = (type: string): string =>
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: type } }] } });

    for (const builtin of ['Explore', 'general-purpose', 'Plan', 'workflow-subagent']) {
      expect(at(parse(anonymizeLine(line(builtin), SEED)), 'message.content[0].input.subagent_type'), builtin).toBe(builtin);
    }

    const qualified = String(at(parse(anonymizeLine(line('acmecorp:auditor'), SEED)), 'message.content[0].input.subagent_type'));
    expect(qualified).not.toContain('acmecorp');
    expect(qualified).not.toContain('auditor');
    // The `:` the engine splits on stays, and each segment keeps its length.
    expect(qualified.split(':').map((s) => s.length)).toEqual([8, 7]);
  });

  it('preserves the origin kind that drives task-notification handling', () => {
    const out = parse(anonymizeLine(TASK_NOTIFICATION_LINE, SEED));
    expect(at(out, 'origin.kind')).toBe('task-notification');
  });
});

describe('anonymizeLine: ids are remapped but keep their shape', () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('keeps uuid v4 shape while changing the value', () => {
    const before = parse(ASSISTANT_LINE);
    const after = parse(anonymizeLine(ASSISTANT_LINE, SEED));
    for (const key of ['uuid', 'parentUuid', 'sessionId']) {
      expect(String(after[key]), key).toMatch(UUID_V4);
      expect(after[key], key).not.toEqual(before[key]);
    }
  });

  it('keeps the toolu_/msg_/req_ prefixes and the exact length', () => {
    const before = parse(ASSISTANT_LINE);
    const after = parse(anonymizeLine(ASSISTANT_LINE, SEED));

    const beforeTool = String(at(before, 'message.content[2].id'));
    const afterTool = String(at(after, 'message.content[2].id'));
    expect(afterTool).toMatch(/^toolu_01[A-Za-z0-9]+$/);
    expect(afterTool).toHaveLength(beforeTool.length);
    expect(afterTool).not.toEqual(beforeTool);

    expect(String(at(after, 'message.id'))).toMatch(/^msg_01[A-Za-z0-9]+$/);
    expect(String(at(after, 'message.id'))).toHaveLength(String(at(before, 'message.id')).length);
    expect(String(after['requestId'])).toMatch(/^req_01[A-Za-z0-9]+$/);
  });

  it('keeps the `a` + 16 hex agent id shape', () => {
    const after = parse(anonymizeLine(ASSISTANT_LINE, SEED));
    expect(String(after['slug'])).toMatch(/^a[0-9a-f]{16}$/);
    expect(after['slug']).not.toBe('a3bc046734e67fd4c');
  });

  it('maps the same id to the same replacement everywhere', () => {
    // The tool_use id in one line and the tool_use_id in the reply must still match.
    const spawnId = at(parse(anonymizeLine(ASSISTANT_LINE, SEED)), 'message.content[2].id');
    const replyId = at(parse(anonymizeLine(TOOL_RESULT_LINE, SEED)), 'message.content[0].tool_use_id');
    expect(replyId).toBe(spawnId);
  });
});

describe('anonymizeLine: structural markers survive verbatim', () => {
  const out = parse(anonymizeLine(TASK_NOTIFICATION_LINE, SEED));
  const text = String(at(out, 'message.content[0].text'));

  it('keeps the task-notification tags and their nesting', () => {
    expect(text.startsWith('<task-notification>')).toBe(true);
    expect(text.endsWith('</task-notification>')).toBe(true);
    for (const tag of ['task-id', 'tool-use-id', 'output-file', 'status', 'summary']) {
      expect(text, tag).toContain(`<${tag}>`);
      expect(text, tag).toContain(`</${tag}>`);
    }
    expect(text.split('\n')).toHaveLength(7);
  });

  it('keeps the inner status enum and the inner id shapes', () => {
    expect(text).toContain('<status>completed</status>');
    const taskId = /<task-id>(.*?)<\/task-id>/.exec(text)?.[1];
    expect(taskId).toMatch(/^a[0-9a-f]{16}$/);
    expect(taskId).not.toBe('a613c14459697b0d2');
    expect(/<tool-use-id>(.*?)<\/tool-use-id>/.exec(text)?.[1]).toMatch(/^toolu_01[A-Za-z0-9]+$/);
  });

  it('replaces the human summary inside the block', () => {
    const summary = /<summary>(.*?)<\/summary>/.exec(text)?.[1] ?? '';
    expect(summary).not.toContain('AcmeCorp');
    expect(summary.length).toBeGreaterThan(0);
  });

  it('keeps the bracket markers the transcript renderer parses', () => {
    const markers = [
      '[Request interrupted by user]',
      '[Request interrupted by user for tool use]',
      '[Pasted text #1 +40 lines]',
      '[Image #2]',
      'Async agent launched successfully',
    ];
    for (const marker of markers) {
      expect(pseudoText(`Before the marker. ${marker} After the marker.`, SEED), marker).toContain(marker);
    }
    expect(pseudoText('<agent-message from="a33e8bf083b3659be">hello there</agent-message>', SEED))
      .toMatch(/^<agent-message from="a[0-9a-f]{16}">.*<\/agent-message>$/);
    expect(pseudoText('<command-name>/compact</command-name>', SEED)).toContain('<command-name>/compact</command-name>');
  });

  it('keeps a tag and its attribute names but not the attribute values', () => {
    // Regression: `<code class="language-solidity">` carried a real project name
    // through in Bash output that happened to contain HTML.
    const out = pseudoText('<code class="language-solidity">x</code>', SEED);
    // Tag name, attribute name, separators and length all survive; the word does not.
    expect(out).toMatch(/^<code class="[a-z]+-[a-z]+">.*<\/code>$/);
    expect(out).not.toContain('solidity');
    expect(/class="([^"]*)"/.exec(out)?.[1]).toHaveLength('language-solidity'.length);
  });

  it('does not let a stray tag in prose turn the rest of the text verbatim', () => {
    // Regression: `<type>` opened a verbatim tag context that never closed, so
    // everything after it in the document was copied through untouched.
    const prose = 'Harmless opening. <type> at ERROR level for AcmeCorp billing, and the rest of this sentence is private.';
    const out = pseudoText(prose, SEED);
    expect(out).not.toContain('AcmeCorp');
    expect(out).not.toContain('ERROR level');
    expect(out).not.toContain('private');
  });

  it('still honours a tag context that does close on the same line', () => {
    expect(pseudoText('<status>completed</status>', SEED)).toBe('<status>completed</status>');
  });

  it('keeps the line count and rough length of multi-line prose', () => {
    const original = 'First line of the note.\nSecond line is a little longer.\n\nFourth line after a blank.';
    const out2 = pseudoText(original, SEED);
    expect(out2.split('\n')).toHaveLength(4);
    expect(out2.split('\n')[2]).toBe('');
    expect(Math.abs(out2.length - original.length)).toBeLessThanOrEqual(2);
  });
});

describe('anonymizeLine: content is actually replaced', () => {
  it('replaces assistant text, thinking and Bash commands', () => {
    const after = parse(anonymizeLine(ASSISTANT_LINE, SEED));
    const thinking = String(at(after, 'message.content[0].thinking'));
    const text = String(at(after, 'message.content[1].text'));
    const command = String(at(after, 'message.content[2].input.command'));

    expect(thinking).not.toContain('customer database');
    expect(text).not.toContain('AcmeCorp');
    expect(command).not.toContain('acme_customers');
    expect(text).toHaveLength('I will rename the AcmeCorp billing table.'.length);
  });

  it('replaces tool output and the prompt a subagent was given', () => {
    const result = parse(anonymizeLine(TOOL_RESULT_LINE, SEED));
    expect(String(at(result, 'toolUseResult.stdout'))).not.toContain('acme');
    expect(String(at(result, 'message.content[0].content'))).not.toContain('acme');

    const spawn = parse(anonymizeLine(AGENT_SPAWN_LINE, SEED));
    expect(String(at(spawn, 'message.content[0].input.prompt'))).not.toContain('AcmeCorp');
    expect(String(at(spawn, 'message.content[0].input.description'))).not.toContain('payment');
  });

  it('rewrites paths but keeps their depth and extension', () => {
    const after = parse(anonymizeLine(ASSISTANT_LINE, SEED));
    const cwd = String(after['cwd']);
    expect(cwd).not.toContain('realname');
    expect(cwd).not.toContain('secret-repo');
    expect(cwd.startsWith('/Users/')).toBe(true);
    expect(cwd.split('/')).toHaveLength('/Users/realname/code/secret-repo/packages/api'.split('/').length);

    const filePath = String(at(parse(anonymizeLine(TOOL_RESULT_LINE, SEED)), 'toolUseResult.filePath'));
    expect(filePath.endsWith('.ts')).toBe(true);
    expect(filePath).not.toContain('billing');
    expect(filePath).not.toContain('realname');
  });

  it('strips a /Users/<name>/ prefix wherever it appears inside prose', () => {
    const out = pseudoText('The log is at /Users/realname/code/secret-repo/out.log on disk.', SEED);
    expect(out).not.toContain('realname');
    expect(out).not.toContain('secret-repo');
  });

  it('keeps a url shape but not the host', () => {
    const out = pseudoText('See https://internal.acmecorp.com/runbooks/payments for details.', SEED);
    expect(out).toContain('https://');
    expect(out).not.toContain('acmecorp');
  });
});

describe('anonymizeLine: determinism', () => {
  it('gives the same output for the same input and seed', () => {
    for (const line of ALL_SAMPLES) {
      expect(anonymizeLine(line, SEED)).toBe(anonymizeLine(line, SEED));
    }
  });

  it('gives a different output for a different seed', () => {
    expect(anonymizeLine(ASSISTANT_LINE, SEED)).not.toBe(anonymizeLine(ASSISTANT_LINE, SEED + 1));
  });

  it('maps equal input strings to equal output strings', () => {
    expect(remapId('a613c14459697b0d2', SEED)).toBe(remapId('a613c14459697b0d2', SEED));
    expect(pseudoText('the same sentence twice', SEED)).toBe(pseudoText('the same sentence twice', SEED));
  });
});

describe('anonymizeLine: secrets are dropped, not transformed', () => {
  const secrets = [
    'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'AKIAIOSFODNN7EXAMPLE',
    'xoxb-1234567890-abcdefghijkl',
  ];

  it('recognises common token shapes', () => {
    for (const secret of secrets) expect(looksLikeSecret(secret), secret).toBe(true);
    expect(looksLikeSecret('just some ordinary prose')).toBe(false);
  });

  it('replaces a secret-shaped value with [redacted]', () => {
    for (const secret of secrets) {
      const line = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: secret }] } });
      const out = parse(anonymizeLine(line, SEED));
      expect(at(out, 'message.content[0].text'), secret).toBe('[redacted]');
    }
  });

  it('redacts a long base64 blob rather than reproducing its length', () => {
    const blob = 'A'.repeat(400);
    const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: blob } }] } });
    const out = parse(anonymizeLine(line, SEED));
    expect(at(out, 'message.content[0].source.data')).toBe('[redacted]');
    expect(at(out, 'message.content[0].source.media_type')).toBe('image/png');
    expect(at(out, 'message.content[0].source.type')).toBe('base64');
  });

  it('does not emit a secret-shaped string of its own', () => {
    for (const line of ALL_SAMPLES) {
      expect(looksLikeSecret(anonymizeLine(line, SEED)), line.slice(0, 40)).toBe(false);
    }
  });
});

describe('anonymizeLine: edge cases', () => {
  it('passes a blank line through untouched', () => {
    expect(anonymizeLine('', SEED)).toBe('');
    expect(anonymizeLine('   ', SEED)).toBe('   ');
  });

  it('anonymizes a line that is not JSON at all rather than echoing it', () => {
    const out = anonymizeLine('plain text with AcmeCorp in it', SEED);
    expect(out).not.toContain('AcmeCorp');
  });

  it('rewrites an object key that is itself a path, since that key is data', () => {
    const line = JSON.stringify({ type: 'file-history-snapshot', snapshot: { trackedFileBackups: { 'secret-repo/billing.ts': { backupFileName: 'e3f9' } } } });
    const keys = Object.keys(at(parse(anonymizeLine(line, SEED)), 'snapshot.trackedFileBackups') as object);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain('secret-repo');
    expect(keys[0]).toMatch(/\.ts$/);
  });

  it('rewrites an object key that is a question, since an answers map is keyed by prose', () => {
    const line = JSON.stringify({ type: 'user', toolUseResult: { answers: { 'What should I name the AcmeCorp sessions?': 'billing' } } });
    const keys = Object.keys(at(parse(anonymizeLine(line, SEED)), 'toolUseResult.answers') as object);
    expect(keys[0]).not.toContain('AcmeCorp');
  });

  it('anonymizes free-text fields that only look enum-ish by their key name', () => {
    // Regression: `reason` was on the preserve list, so a structured-output
    // verdict sentence was copied through word for word.
    const line = JSON.stringify({
      type: 'assistant',
      result: { redteam: [{ verdict: 'needs-guardrail', reason: 'The AcmeCorp baseline was measured with this bug present.' }] },
    });
    const out = parse(anonymizeLine(line, SEED));
    const entry = (at(out, 'result.redteam') as Record<string, string>[])[0] as Record<string, string>;
    expect(entry['verdict']).toBe('needs-guardrail');
    expect(entry['reason']).not.toContain('AcmeCorp');
    expect(entry['reason']).not.toContain('baseline');
  });

  it('never leaves an email address intact', () => {
    const line = JSON.stringify({ type: 'attachment', attachment: { type: 'environment', context: { userEmail: 'someone@realcompany.com' } } });
    const email = String(at(parse(anonymizeLine(line, SEED)), 'attachment.context.userEmail'));
    expect(email).not.toContain('realcompany');
    expect(email).toMatch(/^[a-z]+@[a-z]+\.com$/);
  });
});
